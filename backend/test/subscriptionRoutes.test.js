const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const { createSubscriptionRouter } = require('../subscriptionRoutes');

const WEBHOOK_SECRET = 'print-wallah-test-secret-with-at-least-32-bytes';
const FIXED_NOW = new Date('2026-09-28T00:00:00.000Z');
const shop = {
  id: 'shop-1',
  subscription_status: 'ACTIVE',
  subscription_expiry_date: '2026-10-01T00:00:00.000Z',
};
const expiredShop = {
  id: 'shop-expired',
  subscription_status: 'EXPIRED',
  subscription_expiry_date: '2026-09-27T00:00:00.000Z',
};
const shops = new Map([[shop.id, shop], [expiredShop.id, expiredShop]]);
const appliedPayments = new Map();
let server;
let baseUrl;

function signedPayload(payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return { rawBody, signature: `sha256=${signature}` };
}

before(async () => {
  const app = express();
  const shopRepository = {
    findById: async (shopId) => shops.get(shopId) || null,
    applyVerifiedRenewal: async ({ shopId, paymentId, expectedExpiry, newExpiry }) => {
      if (appliedPayments.has(paymentId)) {
        return { duplicate: true, subscriptionExpiryDate: appliedPayments.get(paymentId) };
      }
      const currentShop = shops.get(shopId);
      if (!currentShop) return null;
      if ((currentShop.subscription_expiry_date ?? null) !== expectedExpiry) return { conflict: true };

      const expiry = newExpiry.toISOString();
      currentShop.subscription_expiry_date = expiry;
      currentShop.subscription_status = 'ACTIVE';
      appliedPayments.set(paymentId, expiry);
      return { duplicate: false, subscriptionExpiryDate: expiry };
    },
  };

  app.use('/api/subscriptions', createSubscriptionRouter({
    shopRepository,
    paymentWebhookSecret: WEBHOOK_SECRET,
    planDurationsDays: { monthly: 30 },
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

test('signed paid renewal extends the current future expiry', async () => {
  const payload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'payment-1',
    shopId: 'shop-1',
    planId: 'monthly',
  };
  const { rawBody, signature } = signedPayload(payload);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
    body: rawBody,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.duplicate, false);
  assert.equal(body.subscription_expiry_date, '2026-10-31T00:00:00.000Z');
});

test('replayed payment callbacks do not extend the shop twice', async () => {
  const payload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'payment-1',
    shopId: 'shop-1',
    planId: 'monthly',
  };
  const { rawBody, signature } = signedPayload(payload);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
    body: rawBody,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.subscription_expiry_date, '2026-10-31T00:00:00.000Z');
  assert.equal(shop.subscription_expiry_date, '2026-10-31T00:00:00.000Z');
});

test('paid renewal reactivates an expired shop', async () => {
  const payload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'payment-reactivation',
    shopId: 'shop-expired',
    planId: 'monthly',
  };
  const { rawBody, signature } = signedPayload(payload);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
    body: rawBody,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(expiredShop.subscription_status, 'ACTIVE');
  assert.equal(body.subscription_expiry_date, '2026-10-28T00:00:00.000Z');
});

test('invalid signatures cannot renew a subscription', async () => {
  const payload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'payment-forged',
    shopId: 'shop-1',
    planId: 'monthly',
  };
  const { rawBody } = signedPayload(payload);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': 'sha256=00' },
    body: rawBody,
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'INVALID_PAYMENT_SIGNATURE' });
  assert.equal(appliedPayments.has('payment-forged'), false);
});

test('signed non-object payloads are rejected as malformed callbacks', async () => {
  const { rawBody, signature } = signedPayload(null);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
    body: rawBody,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_PAYMENT_CALLBACK' });
});

test('unknown plans are rejected without extending access', async () => {
  const payload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'payment-unknown-plan',
    shopId: 'shop-1',
    planId: 'unconfigured',
  };
  const { rawBody, signature } = signedPayload(payload);
  const response = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
    body: rawBody,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'INVALID_PAYMENT_CALLBACK' });
  assert.equal(appliedPayments.has('payment-unknown-plan'), false);
});