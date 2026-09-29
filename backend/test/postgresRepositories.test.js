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
      upiVpa: `${shopId}@upi`,
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
  const updatedSettings = await repositories.shopRepository.updateShopSettings(shop.id, {
    rates: { blackAndWhitePerPage: 2.75, colorPerPage: 9.5 },
    upiId: 'central@upi',
  });
  assert.deepEqual(updatedSettings, {
    rates: { blackAndWhitePerPage: 2.75, colorPerPage: 9.5 },
    upiId: 'central@upi',
  });
  assert.deepEqual(await repositories.shopRepository.getShopSettings(shop.id), updatedSettings);
  assert.equal((await repositories.shopRepository.findById(shop.id)).upiVpa, 'central@upi');

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

test('shop onboarding persists an owner setup token without a password', async () => {
  const shop = await repositories.adminRepository.createShopWithAudit({
    shop: {
      id: 'shop-awaiting-setup',
      shopName: 'Setup Shop',
      ownerName: 'Print Owner',
      ownerEmail: 'owner@example.com',
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
      subscription_status: 'ACTIVE',
      subscription_expiry_date: new Date('2026-10-01T00:00:00.000Z'),
      createdAt: NOW,
    },
    shopAdmin: {
      email: 'owner@example.com',
      setupTokenHash: 'a'.repeat(64),
      setupExpiresAt: new Date('2026-10-05T00:00:00.000Z'),
    },
    audit: {
      adminId: 'admin-1',
      action: 'SHOP_ONBOARDED',
      shopId: 'shop-awaiting-setup',
      details: {},
      createdAt: NOW,
    },
  });

  const account = await pool.query(
    'SELECT password_hash, setup_token_hash, setup_expires_at FROM shop_admin_users WHERE shop_id = $1',
    [shop.id],
  );
  assert.equal(account.rows[0].password_hash, null);
  assert.equal(account.rows[0].setup_token_hash, 'a'.repeat(64));
  assert.equal(new Date(account.rows[0].setup_expires_at).toISOString(), '2026-10-05T00:00:00.000Z');
  await pool.query('DELETE FROM shop_profiles WHERE id = $1', [shop.id]);
});

test('customer orders persist pending payment and become agent jobs only after shop confirmation', async () => {
  const shop = await createShop('shop-customer-order', '2026-10-01T00:00:00.000Z');
  const order = await repositories.printJobRepository.createCustomerOrder({
    id: 'customer-order-1',
    shopId: shop.id,
    documentName: 'customer-order-1.pdf',
    fileName: 'Document.pdf',
    fileUrl: `/api/shops/${shop.id}/print-jobs/customer-order-1/file`,
    pageCount: 3,
    totalAmount: 12,
    copies: 2,
    colorMode: 'bw',
    storageKey: 'customer-order-1.pdf',
    createdAt: NOW,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  });

  assert.equal(order.status, 'AWAITING_PAYMENT');
  assert.equal(order.copies, 2);
  assert.deepEqual(await repositories.printJobRepository.listForShop(shop.id, {
    status: 'READY_TO_PRINT', limit: 25, offset: 0,
  }), { jobs: [], total: 0 });

  const confirmation = await repositories.printJobRepository.confirmCustomerPayment(
    shop.id,
    order.id,
    'UPI-REF-123456',
  );
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.job.status, 'READY_TO_PRINT');
  assert.deepEqual(await repositories.printJobRepository.getFileForAgent(shop.id, order.id), {
    storage_key: 'customer-order-1.pdf',
    file_name: 'Document.pdf',
  });
  assert.equal((await repositories.printJobRepository.confirmCustomerPayment(
    shop.id,
    order.id,
    'UPI-REF-123456',
  )).confirmed, false);
});

test('expiry locking is conditional and metrics classify expired shops', async () => {
  await createShop('shop-expired', '2026-09-27T00:00:00.000Z');
  const expiredShops = await repositories.shopRepository.findExpiredShops(NOW);
  assert.deepEqual(expiredShops.map((entry) => entry.id), ['shop-expired']);

  assert.equal(await repositories.shopRepository.lockIfExpired('shop-expired', NOW), true);
  assert.equal(await repositories.shopRepository.lockIfExpired('shop-expired', NOW), false);
  assert.equal((await repositories.shopRepository.findById('shop-expired')).subscription_status, 'EXPIRED');
  assert.deepEqual(await repositories.shopRepository.getSubscriptionCounts(NOW), {
    total: 3,
    active: 2,
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
