const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSubscriptionCheck } = require('../middleware/subCheck');

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('active subscription proceeds to the protected route', async () => {
  const middleware = createSubscriptionCheck({
    shopRepository: {
      findById: async () => ({ subscription_expiry_date: '2026-10-01T00:00:00.000Z' }),
      lockIfExpired: async () => assert.fail('active shop must not be locked'),
    },
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  let nextCalled = false;

  await middleware({ auth: { shopId: 'shop-1' } }, createResponse(), () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('expired subscription is locked and blocked with a structured 403', async () => {
  let lockedShopId;
  const middleware = createSubscriptionCheck({
    shopRepository: {
      findById: async () => ({ subscription_expiry_date: '2026-09-27T23:59:59.000Z' }),
      lockIfExpired: async (shopId) => { lockedShopId = shopId; },
    },
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });
  const response = createResponse();

  await middleware({ auth: { shopId: 'shop-1' } }, response, () => assert.fail('expired shop passed'));

  assert.equal(lockedShopId, 'shop-1');
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, {
    error: 'SUBSCRIPTION_EXPIRED',
    message: 'Subscription Expired',
  });
});

test('unknown shops are rejected instead of reaching protected routes', async () => {
  const middleware = createSubscriptionCheck({
    shopRepository: {
      findById: async () => null,
      lockIfExpired: async () => assert.fail('unknown shop cannot be locked'),
    },
  });
  const response = createResponse();

  await middleware({ auth: { shopId: 'missing' } }, response, () => assert.fail('unknown shop passed'));

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'SHOP_NOT_FOUND' });
});