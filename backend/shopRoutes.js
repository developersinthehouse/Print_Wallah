const express = require('express');

const PRINT_STATUSES = new Set(['READY_TO_PRINT', 'PRINTED', 'PRINT_FAILED']);
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

function createShopRouter({
  shopRepository,
  printJobRepository,
  authenticateShop,
  requireActiveSubscription,
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
    const dateRange = parseDateRange(request.query);
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
    const { rates, upiId } = request.body || {};
    if (
      !shopRepository.updateShopSettings ||
      !rates ||
      !isValidRate(rates.blackAndWhitePerPage) ||
      !isValidRate(rates.colorPerPage) ||
      !isValidUpiId(upiId)
    ) {
      return response.status(400).json({ error: 'INVALID_SHOP_SETTINGS' });
    }

    try {
      const settings = await shopRepository.updateShopSettings(request.params.shopId, { rates, upiId });
      if (!settings) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }
      return response.json({ settings });
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

  router.post('/:shopId/print-jobs/:jobId/status', async (request, response, next) => {
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