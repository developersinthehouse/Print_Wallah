const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { createShopRouter } = require('../shopRoutes');

const storedRates = { blackAndWhitePerPage: 2, colorPerPage: 8 };
let storedUpiId = '';
let lastUpdatedRates;
let lastShopSettings;
let lastJobResult;
let server;
let baseUrl;

before(async () => {
  const app = express();
  const shopRepository = {
    getRates: async (shopId) => (shopId === 'shop-1' ? storedRates : null),
    getShopSettings: async (shopId) => (shopId === 'shop-1'
      ? { rates: storedRates, upiId: storedUpiId }
      : null),
    updateRates: async (shopId, rates) => {
      if (shopId !== 'shop-1') return null;
      lastUpdatedRates = rates;
      return rates;
    },
    updateShopSettings: async (shopId, settings) => {
      if (shopId !== 'shop-1') return null;
      lastShopSettings = settings;
      storedUpiId = settings.upiId;
      return { ...settings };
    },
  };
  const printJobRepository = {
    getSummary: async () => ({ totalPrints: 12, revenue: 96 }),
    listForShop: async () => ({ jobs: [{ id: 'job-1', status: 'PRINTED' }], total: 1 }),
    updateResult: async (shopId, jobId, result) => {
      if (shopId !== 'shop-1' || jobId !== 'job-1') return null;
      lastJobResult = result;
      return { id: jobId, ...result };
    },
  };
  const authenticateShop = (request, response, next) => {
    request.auth = { shopId: request.get('x-test-shop-id') };
    next();
  };
  const requireActiveSubscription = (request, response, next) => {
    if (request.get('x-test-expired') === 'true') {
      return response.status(403).json({ error: 'SUBSCRIPTION_EXPIRED' });
    }
    return next();
  };

  app.use('/api/shops', createShopRouter({
    shopRepository,
    printJobRepository,
    authenticateShop,
    requireActiveSubscription,
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

test('dashboard returns shop rates, date summary, and recent jobs', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/dashboard`, {
    headers: { 'x-test-shop-id': 'shop-1' },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.rates, storedRates);
  assert.deepEqual(body.shopSettings, { rates: storedRates, upiId: '' });
  assert.deepEqual(body.dailySummary, { totalPrints: 12, revenue: 96 });
  assert.equal(body.recentJobs[0].id, 'job-1');
});

test('shop scope blocks requests for a different shop', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/dashboard`, {
    headers: { 'x-test-shop-id': 'shop-2' },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'SHOP_SCOPE_FORBIDDEN' });
});

test('subscription middleware can stop dashboard requests', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/dashboard`, {
    headers: { 'x-test-shop-id': 'shop-1', 'x-test-expired': 'true' },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'SUBSCRIPTION_EXPIRED' });
});

test('rate updates accept non-negative per-page prices', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/rates`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-shop-id': 'shop-1' },
    body: JSON.stringify({ blackAndWhitePerPage: 2.5, colorPerPage: 9 }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(lastUpdatedRates, { blackAndWhitePerPage: 2.5, colorPerPage: 9 });
});

test('rate updates reject negative or malformed prices', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/rates`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-shop-id': 'shop-1' },
    body: JSON.stringify({ blackAndWhitePerPage: -1, colorPerPage: '8' }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_RATES' });
});

test('print agent can report a result through the shop-scoped endpoint', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/print-jobs/job-1/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-shop-id': 'shop-1' },
    body: JSON.stringify({ status: 'PRINT_FAILED', error: 'Printer unavailable' }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(lastJobResult, { status: 'PRINT_FAILED', error: 'Printer unavailable' });
});

test('shop settings save rates and a valid UPI ID together', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-shop-id': 'shop-1' },
    body: JSON.stringify({
      rates: { blackAndWhitePerPage: 2.5, colorPerPage: 9 },
      upiId: 'centralprints@oksbi',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(lastShopSettings.upiId, 'centralprints@oksbi');
  assert.deepEqual((await response.json()).settings.rates, {
    blackAndWhitePerPage: 2.5,
    colorPerPage: 9,
  });
});

test('shop settings reject malformed UPI IDs', async () => {
  const response = await fetch(`${baseUrl}/api/shops/shop-1/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-shop-id': 'shop-1' },
    body: JSON.stringify({
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
      upiId: 'not-a-upi-id',
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_SHOP_SETTINGS' });
});