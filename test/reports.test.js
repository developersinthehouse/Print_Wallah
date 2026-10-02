const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  parseAnalyticsRange,
  queryPlatformAnalytics,
  queryShopAnalytics,
} = require('../src/services/reports');

test('analytics ranges validate ISO calendar dates, supported buckets, and range size', () => {
  assert.deepEqual(parseAnalyticsRange({ from: '2026-10-01', to: '2026-10-31', groupBy: 'month' }), {
    from: '2026-10-01', to: '2026-10-31', groupBy: 'month', timeZone: 'Asia/Kolkata',
  });
  assert.throws(() => parseAnalyticsRange({ from: '2026-02-30', to: '2026-03-01' }), /YYYY-MM-DD/);
  assert.throws(() => parseAnalyticsRange({ from: '2026-10-02', to: '2026-10-01' }), /end date/);
  assert.throws(() => parseAnalyticsRange({ from: '2026-10-01', to: '2026-10-01', groupBy: 'week' }), /groupBy/);
});

test('shop analytics query groups by selected bucket and returns requested payment and failure metrics', async () => {
  let query;
  const pool = { query: async (sql, values) => { query = { sql, values }; return { rows: [{ orders: 3 }] }; } };
  const rows = await queryShopAnalytics(pool, 'shop-1', {
    from: '2026-10-01', to: '2026-10-31', groupBy: 'month',
  });

  assert.deepEqual(rows, [{ orders: 3 }]);
  assert.match(query.sql, /Asia\/Kolkata/);
  assert.match(query.sql, /date_trunc\('month'/);
  assert.match(query.sql, /payment_pending/);
  assert.match(query.sql, /print_failures/);
  assert.deepEqual(query.values, ['shop-1', '2026-10-01', '2026-10-31']);
});

test('platform analytics groups results by shop and filters dates in India time', async () => {
  let query;
  const pool = { query: async (sql, values) => { query = { sql, values }; return { rows: [{ shop_id: 'ABC' }] }; } };
  const rows = await queryPlatformAnalytics(pool, { from: '2026-10-01', to: '2026-10-02' });

  assert.deepEqual(rows, [{ shop_id: 'ABC' }]);
  assert.match(query.sql, /GROUP BY shops\.id/);
  assert.match(query.sql, /Asia\/Kolkata/);
  assert.match(query.sql, /payment_pending/);
  assert.match(query.sql, /print_failures/);
  assert.deepEqual(query.values, ['2026-10-01', '2026-10-02']);
});