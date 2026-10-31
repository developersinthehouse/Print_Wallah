const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseAnalyticsRange, queryPlatformAnalytics, queryShopAnalytics } = require('../src/services/reports');

function collection(docs) {
  return { where(field, operator, value) {
    assert.equal(operator, '==');
    return { async get() { return { docs: docs.filter((doc) => doc.data[field] === value).map((doc) => ({ id: doc.id, data: () => doc.data })) }; } };
  }, async get() { return { docs: docs.map((doc) => ({ id: doc.id, data: () => doc.data })) }; } };
}
function fakeDb(shops, orders) {
  return { collection(name) { return collection(name === 'shops' ? shops : orders); } };
}
const range = { from: '2026-10-01', to: '2026-10-31', groupBy: 'month', timeZone: 'Asia/Kolkata' };
const order = (overrides = {}) => ({
  created_at: '2026-10-10T12:00:00.000Z', config: { billablePages: 3 }, amount: 12,
  payment_status: 'verified', payment_method: 'upi', print_status: 'failed', shop_id: 'shop-1', ...overrides,
});

test('analytics ranges validate ISO calendar dates, supported buckets, and range size', () => {
  assert.deepEqual(parseAnalyticsRange({ from: '2026-10-01', to: '2026-10-31', groupBy: 'month' }), range);
  assert.throws(() => parseAnalyticsRange({ from: '2026-02-30', to: '2026-03-01' }), /YYYY-MM-DD/);
  assert.throws(() => parseAnalyticsRange({ from: '2026-10-02', to: '2026-10-01' }), /end date/);
  assert.throws(() => parseAnalyticsRange({ from: '2026-10-01', to: '2026-10-01', groupBy: 'week' }), /groupBy/);
});

test('shop analytics groups Firestore orders by month and calculates payment and failure metrics', async () => {
  const db = fakeDb([], [
    { id: 'a', data: order() },
    { id: 'b', data: order({ payment_method: 'cash', amount: 4, print_status: 'completed' }) },
    { id: 'c', data: order({ payment_status: 'pending', amount: 50 }) },
    { id: 'd', data: order({ created_at: '2026-11-01T00:00:00.000Z' }) },
  ]);
  assert.deepEqual(await queryShopAnalytics(db, 'shop-1', range), [{
    activity_date: '2026-10', orders: 3, pages: 9, revenue: 16, online: 12, cash: 4, payment_pending: 1, print_failures: 2,
  }]);
});

test('platform analytics groups Firestore records by shop and excludes orders outside India-local dates', async () => {
  const db = fakeDb([
    { id: 'shop-1', data: { public_id: 'ABC', name: 'Alpha' } },
    { id: 'shop-2', data: { public_id: 'XYZ', name: 'Beta' } },
  ], [
    { id: 'a', data: order() },
    { id: 'b', data: order({ shop_id: 'shop-2', payment_method: 'cash', amount: 7, created_at: '2026-09-30T18:40:00.000Z' }) },
  ]);
  assert.deepEqual(await queryPlatformAnalytics(db, range), [
    { shop_id: 'ABC', shop_name: 'Alpha', orders: 1, pages: 3, revenue: 12, online: 12, cash: 0, payment_pending: 0, print_failures: 1 },
    { shop_id: 'XYZ', shop_name: 'Beta', orders: 1, pages: 3, revenue: 7, online: 0, cash: 7, payment_pending: 0, print_failures: 1 },
  ]);
});
