const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { newDb } = require('pg-mem');
const { runMigrations } = require('../db/migrate');
const { createPostgresRepositories } = require('../postgresRepositories');

const NOW = new Date('2026-09-28T00:00:00.000Z');
let pool;
let repositories;

async function createShop(shopId, expiry, status = 'ACTIVE') {
  return repositories.adminRepository.createShopWithAudit({
    shop: {
      id: shopId,
      shopName: `Shop ${shopId}`,
      ownerName: 'Print Owner',
      ownerEmail: `${shopId}@example.com`,
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
      subscription_status: status,
      subscription_expiry_date: new Date(expiry),
      createdAt: NOW,
    },
    audit: {
      adminId: 'admin-1',
      action: 'SHOP_ONBOARDED',
      shopId,
      details: { planId: 'monthly' },
      createdAt: NOW,
    },
  });
}

before(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  pool = new Pool();
  await runMigrations(pool);
  await runMigrations(pool);
  repositories = createPostgresRepositories(pool);
});

after(async () => {
  await pool.end();
});

test('migrations and repositories persist shop, print, renewal, and audit data', async () => {
  const shop = await createShop('shop-active', '2026-10-01T00:00:00.000Z');
  assert.equal(shop.id, 'shop-active');
  assert.deepEqual(await repositories.shopRepository.getRates(shop.id), {
    blackAndWhitePerPage: 2,
    colorPerPage: 8,
  });

  const updatedRates = await repositories.shopRepository.updateRates(shop.id, {
    blackAndWhitePerPage: 2.5,
    colorPerPage: 9,
  });
  assert.deepEqual(updatedRates, { blackAndWhitePerPage: 2.5, colorPerPage: 9 });

  const originalExpiry = shop.subscription_expiry_date;
  const newExpiry = new Date('2026-10-31T00:00:00.000Z');
  const renewal = await repositories.shopRepository.applyVerifiedRenewal({
    shopId: shop.id,
    paymentId: 'payment-1',
    planId: 'monthly',
    expectedExpiry: originalExpiry,
    newExpiry,
    renewedAt: NOW,
  });
  const replay = await repositories.shopRepository.applyVerifiedRenewal({
    shopId: shop.id,
    paymentId: 'payment-1',
    planId: 'monthly',
    expectedExpiry: originalExpiry,
    newExpiry: new Date('2026-11-30T00:00:00.000Z'),
    renewedAt: NOW,
  });
  assert.equal(renewal.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(new Date(replay.subscriptionExpiryDate).toISOString(), newExpiry.toISOString());

  await pool.query(
    `INSERT INTO print_jobs
      (id, shop_id, document_name, file_name, file_url, page_count, total_amount, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ['job-1', shop.id, 'Order 1', 'order.pdf', 'https://files.example.com/order.pdf', 12, 96, 'READY_TO_PRINT', NOW],
  );
  const readyJobs = await repositories.printJobRepository.listForShop(shop.id, {
    status: 'READY_TO_PRINT', limit: 25, offset: 0,
  });
  assert.equal(readyJobs.jobs[0].fileUrl, 'https://files.example.com/order.pdf');
  const printedJob = await repositories.printJobRepository.updateResult(shop.id, 'job-1', {
    status: 'PRINTED',
  });
  const repeatedResult = await repositories.printJobRepository.updateResult(shop.id, 'job-1', {
    status: 'PRINTED',
  });
  assert.equal(printedJob.status, 'PRINTED');
  assert.equal(repeatedResult.status, 'PRINTED');
  assert.deepEqual(await repositories.printJobRepository.getSummary(shop.id, {
    from: new Date('2026-09-27T00:00:00.000Z'),
    to: new Date('2026-09-29T00:00:00.000Z'),
  }), { totalPrints: 1, revenue: 96 });
  assert.equal(await repositories.printJobRepository.getPlatformVolume(), 96);

  const subscriptionLogs = await pool.query(
    'SELECT COUNT(*)::int AS total FROM subscription_logs WHERE payment_id = $1',
    ['payment-1'],
  );
  const auditLogs = await pool.query(
    'SELECT COUNT(*)::int AS total FROM admin_audit WHERE shop_id = $1',
    [shop.id],
  );
  assert.equal(subscriptionLogs.rows[0].total, 1);
  assert.equal(auditLogs.rows[0].total, 1);
});

test('expiry locking is conditional and metrics classify expired shops', async () => {
  await createShop('shop-expired', '2026-09-27T00:00:00.000Z');
  const expiredShops = await repositories.shopRepository.findExpiredShops(NOW);
  assert.deepEqual(expiredShops.map((entry) => entry.id), ['shop-expired']);

  assert.equal(await repositories.shopRepository.lockIfExpired('shop-expired', NOW), true);
  assert.equal(await repositories.shopRepository.lockIfExpired('shop-expired', NOW), false);
  assert.equal((await repositories.shopRepository.findById('shop-expired')).subscription_status, 'EXPIRED');
  assert.deepEqual(await repositories.shopRepository.getSubscriptionCounts(NOW), {
    total: 2,
    active: 1,
    expired: 1,
    locked: 0,
  });
});

test('admin subscription updates compare expiry and write audit atomically', async () => {
  const shop = await createShop('shop-admin', '2026-10-01T00:00:00.000Z');
  const lockResult = await repositories.adminRepository.updateSubscriptionWithAudit({
    shopId: shop.id,
    expectedExpiry: null,
    update: { subscription_status: 'LOCKED', subscription_lock_reason: 'Review' },
    audit: {
      adminId: 'admin-2', action: 'SUBSCRIPTION_LOCKED', shopId: shop.id,
      reason: 'Review', details: {}, createdAt: NOW,
    },
  });
  assert.equal(lockResult.shop.subscription_status, 'LOCKED');

  const conflict = await repositories.adminRepository.updateSubscriptionWithAudit({
    shopId: shop.id,
    expectedExpiry: new Date('2026-10-02T00:00:00.000Z'),
    update: { subscription_status: 'ACTIVE', subscription_expiry_date: new Date('2026-11-01T00:00:00.000Z') },
    audit: {
      adminId: 'admin-2', action: 'SUBSCRIPTION_EXTENDED', shopId: shop.id,
      reason: 'Renewal', details: { planId: 'monthly' }, createdAt: NOW,
    },
  });
  assert.equal(conflict.conflict, true);

  const auditLogs = await pool.query(
    'SELECT COUNT(*)::int AS total FROM admin_audit WHERE shop_id = $1',
    [shop.id],
  );
  assert.equal(auditLogs.rows[0].total, 2);
});