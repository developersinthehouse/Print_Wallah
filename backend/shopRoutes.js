const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const PRINT_STATUSES = new Set(['AWAITING_PAYMENT', 'PAYMENT_EXPIRED', 'READY_TO_PRINT', 'PRINTED', 'PRINT_FAILED']);
const RESULT_STATUSES = new Set(['PRINTED', 'PRINT_FAILED']);
const MAX_HISTORY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

function parseDateRange(query) {
  if (!query.from && !query.to) {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
  }

  const from = new Date(query.from);
  const to = new Date(query.to);
  if (
    !query.from ||
    !query.to ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > MAX_HISTORY_RANGE_MS
  ) {
    return null;
  }
  return { from, to };
}

function parsePagination(query) {
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return null;
  }
  return { limit, offset };
}

function isValidRate(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100000 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-8
  );
}

function isValidUpiId(value) {
  return value === '' || (
    typeof value === 'string' &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(value)
  );
}

function isValidPrintOptions(options) {
  return Boolean(options) &&
    typeof options.documentEnabled === 'boolean' &&
    typeof options.photoEnabled === 'boolean' &&
    (options.documentEnabled || options.photoEnabled) &&
    typeof options.glossyEnabled === 'boolean' &&
    isValidRate(options.photoPrice) &&
    isValidRate(options.glossySurchargePerPage);
}

function createShopRouter({
  shopRepository,
  printJobRepository,
  authenticateShop,
  requireActiveSubscription,
  agentTokenRepository,
  customerUploadDirectory = path.join(__dirname, 'uploads', 'customer'),
  getAuthenticatedShopId = (request) => request.auth?.shopId,
}) {
  if (
    !shopRepository ||
    !printJobRepository ||
    typeof authenticateShop !== 'function' ||
    typeof requireActiveSubscription !== 'function'
  ) {
    throw new TypeError('Repositories and shop authentication/subscription middleware are required');
  }

  const router = express.Router();
  router.use(authenticateShop, requireActiveSubscription, express.json({ limit: '32kb' }));
  router.param('shopId', (request, response, next, shopId) => {
    if (String(getAuthenticatedShopId(request) ?? '') !== shopId) {
      return response.status(403).json({ error: 'SHOP_SCOPE_FORBIDDEN' });
    }
    return next();
  });

  router.get('/:shopId/dashboard', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    const dateRange = parseDateRange(request.query);
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    if (!dateRange) {
      return response.status(400).json({ error: 'INVALID_DATE_RANGE' });
    }

    try {
      const shopId = request.params.shopId;
      const [rates, shopSettings, dailySummary, history] = await Promise.all([
        shopRepository.getRates(shopId),
        shopRepository.getShopSettings ? shopRepository.getShopSettings(shopId) : null,
        printJobRepository.getSummary(shopId, dateRange),
        printJobRepository.listForShop(shopId, { ...dateRange, limit: 50, offset: 0 }),
      ]);

      if (!rates) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }
      return response.json({ rates, shopSettings, dailySummary, recentJobs: history.jobs });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:shopId/rates', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    const rates = request.body;
    if (
      !rates ||
      !isValidRate(rates.blackAndWhitePerPage) ||
      !isValidRate(rates.colorPerPage)
    ) {
      return response.status(400).json({ error: 'INVALID_RATES' });
    }

    try {
      const savedRates = await shopRepository.updateRates(request.params.shopId, {
        blackAndWhitePerPage: rates.blackAndWhitePerPage,
        colorPerPage: rates.colorPerPage,
      });
      if (!savedRates) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }
      return response.json({ rates: savedRates });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:shopId/settings', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    const { rates, upiId, printOptions } = request.body || {};
    if (
      !shopRepository.updateShopSettings ||
      !rates ||
      !isValidRate(rates.blackAndWhitePerPage) ||
      !isValidRate(rates.colorPerPage) ||
      !isValidUpiId(upiId) ||
      !isValidPrintOptions(printOptions)
    ) {
      return response.status(400).json({ error: 'INVALID_SHOP_SETTINGS' });
    }

    try {
      const settings = await shopRepository.updateShopSettings(request.params.shopId, { rates, upiId, printOptions });
      if (!settings) return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      return response.json({ settings });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:shopId/print-queue', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    if (typeof printJobRepository.listPrintQueue !== 'function') {
      return response.status(503).json({ error: 'PRINT_QUEUE_UNAVAILABLE' });
    }
    try {
      const jobs = await printJobRepository.listPrintQueue(request.params.shopId);
      return response.json({ jobs });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/:shopId/print-queue', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    const { jobIds } = request.body || {};
    if (
      !Array.isArray(jobIds) || jobIds.length > 500 ||
      jobIds.some((id) => typeof id !== 'string' || !id || id.length > 120) ||
      new Set(jobIds).size !== jobIds.length
    ) {
      return response.status(400).json({ error: 'INVALID_PRINT_QUEUE' });
    }
    if (typeof printJobRepository.reorderPrintQueue !== 'function') {
      return response.status(503).json({ error: 'PRINT_QUEUE_UNAVAILABLE' });
    }
    try {
      const result = await printJobRepository.reorderPrintQueue(request.params.shopId, jobIds);
      if (!result) return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      if (result.conflict) return response.status(409).json({ error: 'PRINT_QUEUE_CHANGED' });
      return response.json({ jobs: result.jobs });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:shopId/print-jobs', async (request, response, next) => {
    const dateRange = request.query.from || request.query.to ? parseDateRange(request.query) : {};
    const pagination = parsePagination(request.query);
    const status = request.query.status;

    if (
      !dateRange ||
      !pagination ||
      (status !== undefined && !PRINT_STATUSES.has(status))
    ) {
      return response.status(400).json({ error: 'INVALID_JOB_QUERY' });
    }
    if (request.auth?.role === 'PRINT_AGENT' && status !== 'READY_TO_PRINT') {
      return response.status(403).json({ error: 'PRINT_AGENT_READY_JOBS_ONLY' });
    }
    if (request.auth?.role === 'PRINT_AGENT' && status !== 'READY_TO_PRINT') {
      return response.status(403).json({ error: 'PRINT_AGENT_READY_JOBS_ONLY' });
    }

    try {
      const result = await printJobRepository.listForShop(request.params.shopId, {
        ...dateRange,
        ...pagination,
        status,
      });
      return response.json({ jobs: result.jobs, total: result.total });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:shopId/agent-tokens', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    if (!agentTokenRepository) return response.status(503).json({ error: 'AGENT_TOKENS_UNAVAILABLE' });
    try {
      const tokens = await agentTokenRepository.listForShop(request.params.shopId);
      return response.json({ tokens });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:shopId/agent-tokens', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    if (!agentTokenRepository) return response.status(503).json({ error: 'AGENT_TOKENS_UNAVAILABLE' });
    const label = typeof request.body?.label === 'string' ? request.body.label.trim() : '';
    if (label.length < 2 || label.length > 80) {
      return response.status(400).json({ error: 'INVALID_AGENT_TOKEN_LABEL' });
    }
    try {
      const rawToken = `pwa_${crypto.randomBytes(32).toString('base64url')}`;
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 365 * 24 * 60 * 60 * 1000);
      const token = await agentTokenRepository.create({
        id: crypto.randomUUID(),
        shopId: request.params.shopId,
        label,
        tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        createdAt,
        expiresAt,
      });
      return response.status(201).json({ token: { ...token, secret: rawToken } });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/:shopId/agent-tokens/:tokenId', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    if (!agentTokenRepository) return response.status(503).json({ error: 'AGENT_TOKENS_UNAVAILABLE' });
    try {
      const revoked = await agentTokenRepository.revoke(request.params.shopId, request.params.tokenId);
      if (!revoked) return response.status(404).json({ error: 'AGENT_TOKEN_NOT_FOUND' });
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:shopId/print-jobs/:jobId/payment-confirmation', async (request, response, next) => {
    if (request.auth?.role !== 'SHOP_ADMIN') {
      return response.status(403).json({ error: 'SHOP_ADMIN_REQUIRED' });
    }
    const paymentReference = typeof request.body?.paymentReference === 'string'
      ? request.body.paymentReference.trim()
      : '';
    if (paymentReference.length < 4 || paymentReference.length > 120) {
      return response.status(400).json({ error: 'INVALID_PAYMENT_REFERENCE' });
    }

    try {
      const result = await printJobRepository.confirmCustomerPayment(
        request.params.shopId,
        request.params.jobId,
        paymentReference,
      );
      if (!result) return response.status(404).json({ error: 'PRINT_JOB_NOT_FOUND' });
      if (!result.confirmed) return response.status(409).json({ error: 'PAYMENT_CONFIRMATION_CONFLICT' });
      return response.json({ job: result.job });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:shopId/print-jobs/:jobId/file', async (request, response, next) => {
    if (request.auth?.role !== 'PRINT_AGENT') {
      return response.status(403).json({ error: 'PRINT_AGENT_REQUIRED' });
    }
    try {
      const file = await printJobRepository.getFileForAgent(request.params.shopId, request.params.jobId);
      if (!file || typeof file.storage_key !== 'string' || path.basename(file.storage_key) !== file.storage_key) {
        return response.status(404).json({ error: 'PRINT_FILE_NOT_FOUND' });
      }
      return response.download(file.storage_key, file.file_name || file.storage_key, {
        root: customerUploadDirectory,
      }, (error) => {
        if (error && !response.headersSent) next(error);
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:shopId/print-jobs/:jobId/status', async (request, response, next) => {
    if (request.auth?.role !== 'PRINT_AGENT') {
      return response.status(403).json({ error: 'PRINT_AGENT_REQUIRED' });
    }
    const { status, error } = request.body || {};
    if (
      !RESULT_STATUSES.has(status) ||
      (error !== undefined && (typeof error !== 'string' || error.length > 1000))
    ) {
      return response.status(400).json({ error: 'INVALID_JOB_RESULT' });
    }

    try {
      const job = await printJobRepository.updateResult(
        request.params.shopId,
        request.params.jobId,
        { status, error: error || undefined },
      );
      if (!job) {
        return response.status(404).json({ error: 'PRINT_JOB_NOT_FOUND' });
      }
      return response.json({ job });
    } catch (repositoryError) {
      return next(repositoryError);
    }
  });

  return router;
}

module.exports = { createShopRouter };
