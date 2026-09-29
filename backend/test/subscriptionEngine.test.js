const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  calculateRenewalExpiry,
  lockExpiredShops,
} = require('../subscriptionEngine');

test('renewal extends from the future expiry instead of shortening prepaid time', () => {
  const expiry = calculateRenewalExpiry(
    '2026-10-01T00:00:00.000Z',
    '2026-09-28T00:00:00.000Z',
    30,
  );

  assert.equal(expiry.toISOString(), '2026-10-31T00:00:00.000Z');
});

test('renewal starts from now when the old subscription has expired', () => {
  const expiry = calculateRenewalExpiry(
    '2026-09-01T00:00:00.000Z',
    '2026-09-28T00:00:00.000Z',
    30,
  );

  assert.equal(expiry.toISOString(), '2026-10-28T00:00:00.000Z');
});

test('expiry sweep conditionally locks only repositories that update successfully', async () => {
  const locked = [];
  const count = await lockExpiredShops({
    shopRepository: {
      findExpiredShops: async () => [{ id: 'shop-1' }, { id: 'shop-2' }],
      lockIfExpired: async (shopId, now) => {
        assert.equal(now.toISOString(), '2026-09-28T00:00:00.000Z');
        locked.push(shopId);
        return shopId === 'shop-1';
      },
    },
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  });

  assert.deepEqual(locked.sort(), ['shop-1', 'shop-2']);
  assert.equal(count, 1);
});

test('renewal duration must be a positive whole number of days', () => {
  assert.throws(
    () => calculateRenewalExpiry(null, '2026-09-28T00:00:00.000Z', 0),
    RangeError,
  );
});