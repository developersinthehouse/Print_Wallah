const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createSuperAdminAuth, createSuperAdminRouter } = require('../adminRoutes');

const JWT_SECRET = 'print-wallah-super-admin-test-secret-with-32-bytes';
const FIXED_NOW = new Date('2026-09-28T00:00:00.000Z');
const shops = new Map();
const auditEntries = [];
let server;
let baseUrl;

function makeToken(role = 'SUPER_ADMIN') {
  return jwt.sign({ role }, JWT_SECRET, {
    subject: 'admin-1',
    issuer: 'print-wallah-tests',
    audience: 'developers-admin',
    expiresIn: '5m',
    algorithm: 'HS256',
  });
}

async function adminRequest(path, { token = makeToken(), ...options } = {}) {
  return fetch(`${baseUrl}/api/admin${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

before(async () => {
  const app = express();
  const shopRepository = {
    findById: async (shopId) => shops.get(shopId) || null,
    listShops: async ({ limit, offset, status, search }) => {
      const matchingShops = [...shops.values()].filter((shop) =>
        (!status || shop.subscription_status === status) &&
        (!search || `${shop.shopName} ${shop.ownerEmail}`.toLowerCase().includes(search.toLowerCase())),
      );
      return { shops: matchingShops.slice(offset, offset + limit), total: matchingShops.length };
    },
    getSubscriptionCounts: async () => ({ total: 1, active: 1, expired: 0, locked: 0 }),
  };
  const printJobRepository = { getPlatformVolume: async () => 24500 };
  const adminRepository = {
    createShopWithAudit: async ({ shop, audit }) => {
      if (shops.has(shop.id)) return null;
      shops.set(shop.id, shop);
      auditEntries.push(audit);
      return shop;
    },
    updateSubscriptionWithAudit: async ({ shopId, expectedExpiry, update, audit }) => {
      const shop = shops.get(shopId);
      if (!shop) return null;
      if (expectedExpiry !== null && (shop.subscription_expiry_date ?? null) !== expectedExpiry) {
        return { conflict: true };
      }
      Object.assign(shop, update);
      auditEntries.push(audit);
      return { shop };
    },
  };
  const authenticateSuperAdmin = createSuperAdminAuth({
    jwtSecret: JWT_SECRET,
    issuer: 'print-wallah-tests',
    audience: 'developers-admin',
  });

  app.use('/api/admin', createSuperAdminRouter({
    shopRepository,
    printJobRepository,
    adminRepository,
    authenticateSuperAdmin,
    onboardingBaseUrl: 'https://print.example.com/start',
    planDurationsDays: { monthly: 30, annual: 365 },
    now: () => new Date(FIXED_NOW),
  }));
  app.use((error, request, response, next) => {
    response.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('super-admin endpoints reject missing and non-admin tokens', async () => {
  const missing = await adminRequest('/metrics', { token: null });
  const shopToken = await adminRequest('/metrics', { token: makeToken('SHOP_ADMIN') });

  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'ADMIN_AUTH_REQUIRED' });
  assert.equal(shopToken.status, 403);
  assert.deepEqual(await shopToken.json(), { error: 'SUPER_ADMIN_REQUIRED' });
});

test('onboarding creates an active shop with a unique ID and QR code', async () => {
  const response = await adminRequest('/shops', {
    method: 'POST',
    body: JSON.stringify({
      shopName: 'Central Prints',
      ownerName: 'Asha Rao',
      ownerEmail: 'asha@example.com',
      planId: 'monthly',
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.match(body.shop.id, /^pw_[0-9a-f-]{36}$/);
  assert.equal(body.shop.subscription_status, 'ACTIVE');
  assert.equal(body.shop.subscription_expiry_date, '2026-10-28T00:00:00.000Z');
  assert.match(body.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.match(body.shopAdminSetupToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Date(body.shopAdminSetupExpiresAt).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(new URL(body.onboardingUrl).searchParams.get('shopId'), body.shop.id);
  assert.equal(auditEntries.at(-1).action, 'SHOP_ONBOARDED');
});

test('global metrics return subscription counts and platform volume', async () => {
  const response = await adminRequest('/metrics');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    totalShops: 1,
    activeSubscriptions: 1,
    expiredAccounts: 0,
    lockedAccounts: 0,
    platformVolume: 24500,
  });
});

test('shop directory supports filtering and pagination', async () => {
  const response = await adminRequest('/shops?status=ACTIVE&limit=10&offset=0');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.shops[0].shopName, 'Central Prints');
});

test('manual lock changes state and writes an audit event', async () => {
  const shopId = [...shops.keys()][0];
  const response = await adminRequest(`/shops/${shopId}/subscription`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'LOCK', reason: 'Payment dispute review' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.shop.subscription_status, 'LOCKED');
  assert.equal(auditEntries.at(-1).action, 'SUBSCRIPTION_LOCKED');
  assert.equal(auditEntries.at(-1).adminId, 'admin-1');
});

test('manual extension restores access and records the configured plan', async () => {
  const shopId = [...shops.keys()][0];
  const response = await adminRequest(`/shops/${shopId}/subscription`, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'EXTEND', planId: 'monthly', reason: 'Renewal approved' }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.shop.subscription_status, 'ACTIVE');
  assert.equal(body.shop.subscription_expiry_date, '2026-11-27T00:00:00.000Z');
  assert.equal(auditEntries.at(-1).action, 'SUBSCRIPTION_EXTENDED');
});

test('invalid onboarding profiles and override actions are rejected', async () => {
  const invalidShop = await adminRequest('/shops', {
    method: 'POST',
    body: JSON.stringify({ shopName: 'X', planId: 'free' }),
  });
  const invalidOverride = await adminRequest('/shops/not-a-shop/subscription', {
    method: 'PATCH',
    body: JSON.stringify({ action: 'UNLOCK', reason: 'Not allowed' }),
  });

  assert.equal(invalidShop.status, 400);
  assert.deepEqual(await invalidShop.json(), { error: 'INVALID_SHOP_PROFILE' });
  assert.equal(invalidOverride.status, 400);
  assert.deepEqual(await invalidOverride.json(), { error: 'INVALID_SUBSCRIPTION_OVERRIDE' });
});