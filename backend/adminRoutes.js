const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { calculateRenewalExpiry } = require('./subscriptionEngine');

const ALLOWED_SHOP_STATUSES = new Set(['ACTIVE', 'EXPIRED', 'LOCKED']);

function createSuperAdminAuth({ jwtSecret, issuer, audience }) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new TypeError('Super-admin JWT secret must contain at least 32 bytes');
  }
  if (!issuer || !audience) {
    throw new TypeError('Super-admin JWT issuer and audience are required');
  }

  return function authenticateSuperAdmin(request, response, next) {
    const authorization = request.get('authorization') || '';
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!tokenMatch) {
      return response.status(401).json({ error: 'ADMIN_AUTH_REQUIRED' });
    }

    try {
      const claims = jwt.verify(tokenMatch[1], jwtSecret, {
        algorithms: ['HS256'],
        issuer,
        audience,
      });
      if (claims.role !== 'SUPER_ADMIN' || typeof claims.sub !== 'string' || !claims.sub) {
        return response.status(403).json({ error: 'SUPER_ADMIN_REQUIRED' });
      }
      request.admin = { id: claims.sub };
      return next();
    } catch {
      return response.status(401).json({ error: 'INVALID_ADMIN_TOKEN' });
    }
  };
}

function validateRates(rates) {
  if (!rates || typeof rates !== 'object') return false;
  return ['blackAndWhitePerPage', 'colorPerPage'].every((key) => {
    const value = rates[key];
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100000 &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-8
    );
  });
}

function parsePagination(query) {
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    return null;
  }
  return { limit, offset };
}

function createSuperAdminRouter({
  shopRepository,
  printJobRepository,
  adminRepository,
  authenticateSuperAdmin,
  onboardingBaseUrl,
  planDurationsDays,
  qrCodeGenerator = QRCode.toDataURL,
  now = () => new Date(),
}) {
  if (
    !shopRepository ||
    typeof shopRepository.findById !== 'function' ||
    typeof shopRepository.listShops !== 'function' ||
    typeof shopRepository.getSubscriptionCounts !== 'function' ||
    !printJobRepository ||
    typeof printJobRepository.getPlatformVolume !== 'function' ||
    !adminRepository ||
    typeof adminRepository.createShopWithAudit !== 'function' ||
    typeof adminRepository.updateSubscriptionWithAudit !== 'function' ||
    typeof authenticateSuperAdmin !== 'function'
  ) {
    throw new TypeError('Repositories and super-admin authentication middleware are required');
  }
  if (
    !planDurationsDays ||
    Object.keys(planDurationsDays).length === 0 ||
    Object.values(planDurationsDays).some((days) => !Number.isInteger(days) || days < 1)
  ) {
    throw new TypeError('Configure at least one subscription plan duration');
  }

  let onboardingUrl;
  try {
    onboardingUrl = new URL(onboardingBaseUrl);
    if (!['http:', 'https:'].includes(onboardingUrl.protocol)) throw new Error('Unsupported protocol');
  } catch {
    throw new TypeError('Onboarding base URL must be an absolute HTTP(S) URL');
  }

  const router = express.Router();
  router.use(authenticateSuperAdmin, express.json({ limit: '32kb' }));

  router.get('/plans', (request, response) => {
    const plans = Object.entries(planDurationsDays).map(([id, durationDays]) => ({ id, durationDays }));
    return response.json({ plans });
  });

  router.get('/metrics', async (request, response, next) => {
    try {
      const [subscriptions, platformVolume] = await Promise.all([
        shopRepository.getSubscriptionCounts(now()),
        printJobRepository.getPlatformVolume(),
      ]);
      return response.json({
        totalShops: subscriptions.total,
        activeSubscriptions: subscriptions.active,
        expiredAccounts: subscriptions.expired,
        lockedAccounts: subscriptions.locked,
        platformVolume,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/shops', async (request, response, next) => {
    const pagination = parsePagination(request.query);
    const status = request.query.status;
    const search = typeof request.query.search === 'string' ? request.query.search.trim().slice(0, 100) : '';
    if (!pagination || (status !== undefined && !ALLOWED_SHOP_STATUSES.has(status))) {
      return response.status(400).json({ error: 'INVALID_SHOP_QUERY' });
    }

    try {
      const result = await shopRepository.listShops({ ...pagination, status, search });
      return response.json({ shops: result.shops, total: result.total });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/shops', async (request, response, next) => {
    const body = request.body || {};
    const shopName = typeof body.shopName === 'string' ? body.shopName.trim() : '';
    const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';
    const ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim().toLowerCase() : '';
    const upiVpa = typeof body.upiVpa === 'string' ? body.upiVpa.trim() : '';
    const planId = body.planId;

    if (
      shopName.length < 2 || shopName.length > 120 ||
      ownerName.length < 2 || ownerName.length > 120 ||
      ownerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) ||
      (body.upiVpa !== undefined && (
        typeof body.upiVpa !== 'string' ||
        (upiVpa !== '' && !/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(upiVpa))
      )) ||
      typeof planId !== 'string' || !Object.hasOwn(planDurationsDays, planId) ||
      !validateRates(body.rates)
    ) {
      return response.status(400).json({ error: 'INVALID_SHOP_PROFILE' });
    }

    try {
      const createdAt = now();
      const shopId = `pw_${crypto.randomUUID()}`;
      const shopAdminSetupToken = crypto.randomBytes(32).toString('base64url');
      const shopAdminSetupTokenHash = crypto.createHash('sha256').update(shopAdminSetupToken).digest('hex');
      const shopAdminSetupExpiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      const qrUrl = new URL(onboardingUrl);
      qrUrl.searchParams.set('shopId', shopId);
      const qrCodeDataUrl = await qrCodeGenerator(qrUrl.toString());
      const subscriptionExpiryDate = calculateRenewalExpiry(
        null,
        createdAt,
        planDurationsDays[planId],
      );
      const shop = {
        id: shopId,
        shopName,
        ownerName,
        ownerEmail,
        upiVpa,
        rates: body.rates,
        subscription_status: 'ACTIVE',
        subscription_expiry_date: subscriptionExpiryDate,
        createdAt,
      };
      const createdShop = await adminRepository.createShopWithAudit({
        shop,
        shopAdmin: {
          email: ownerEmail,
          setupTokenHash: shopAdminSetupTokenHash,
          setupExpiresAt: shopAdminSetupExpiresAt,
        },
        audit: {
          adminId: request.admin.id,
          action: 'SHOP_ONBOARDED',
          shopId,
          details: { planId },
          createdAt,
        },
      });

      if (!createdShop) {
        return response.status(409).json({ error: 'SHOP_ID_CONFLICT' });
      }
      return response.status(201).json({
        shop: createdShop,
        onboardingUrl: qrUrl.toString(),
        qrCodeDataUrl,
        shopAdminSetupToken,
        shopAdminSetupExpiresAt,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/shops/:shopId/subscription', async (request, response, next) => {
    const { action, planId, reason } = request.body || {};
    if (
      !['LOCK', 'EXTEND'].includes(action) ||
      typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500 ||
      (action === 'EXTEND' && (typeof planId !== 'string' || !Object.hasOwn(planDurationsDays, planId)))
    ) {
      return response.status(400).json({ error: 'INVALID_SUBSCRIPTION_OVERRIDE' });
    }

    try {
      const shopId = request.params.shopId;
      const changedAt = now();
      let expectedExpiry = null;
      let update;
      let auditAction;

      if (action === 'LOCK') {
        update = { subscription_status: 'LOCKED', subscription_lock_reason: reason.trim() };
        auditAction = 'SUBSCRIPTION_LOCKED';
      } else {
        const shop = await shopRepository.findById(shopId);
        if (!shop) {
          return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
        }
        expectedExpiry = shop.subscription_expiry_date ?? null;
        update = {
          subscription_status: 'ACTIVE',
          subscription_expiry_date: calculateRenewalExpiry(
            expectedExpiry,
            changedAt,
            planDurationsDays[planId],
          ),
          subscription_lock_reason: null,
        };
        auditAction = 'SUBSCRIPTION_EXTENDED';
      }

      const result = await adminRepository.updateSubscriptionWithAudit({
        shopId,
        expectedExpiry,
        update,
        audit: {
          adminId: request.admin.id,
          action: auditAction,
          shopId,
          reason: reason.trim(),
          details: action === 'EXTEND' ? { planId } : {},
          createdAt: changedAt,
        },
      });
      if (!result) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }
      if (result.conflict) {
        return response.status(409).json({ error: 'SUBSCRIPTION_UPDATE_CONFLICT' });
      }
      return response.json({ shop: result.shop || result });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSuperAdminAuth, createSuperAdminRouter };
