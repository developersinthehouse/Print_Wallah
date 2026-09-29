const assert = require('node:assert/strict');
const { test } = require('node:test');
const { newDb } = require('pg-mem');
const { verifyPassword } = require('../adminSessionRoutes');
const { runMigrations } = require('../db/migrate');
const { bootstrapAdmin } = require('../scripts/bootstrapAdmin');

const environment = {
  DATABASE_URL: 'postgresql://print_wallah:test@localhost:5432/print_wallah',
  DATABASE_SSL: 'false',
  SHOP_JWT_SECRET: 'bootstrap-shop-secret-with-at-least-32-bytes',
  SUPER_ADMIN_JWT_SECRET: 'bootstrap-admin-secret-with-at-least-32-bytes',
  PAYMENT_WEBHOOK_SECRET: 'bootstrap-payment-secret-with-at-least-32-bytes',
  PRINT_WALLAH_ONBOARDING_URL: 'https://print.example.com/start',
  SUBSCRIPTION_PLANS: 'monthly:30',
  SUPER_ADMIN_EMAIL: 'developers@example.com',
  SUPER_ADMIN_PASSWORD: 'secure-test-password-123',
};

async function createPoolFactory() {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  const setupPool = new Pool();
  await runMigrations(setupPool);
  await setupPool.end();
  return () => new Pool();
}

test('bootstrap creates one admin with a verifiable scrypt hash', async () => {
  const poolFactory = await createPoolFactory();

  await bootstrapAdmin(environment, { poolFactory, logger: { info() {} } });

  const pool = poolFactory();
  const result = await pool.query(
    'SELECT email, password_hash FROM super_admin_users WHERE email = $1',
    ['developers@example.com'],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].password_hash.startsWith('scrypt$'), true);
  assert.equal(result.rows[0].password_hash.includes(environment.SUPER_ADMIN_PASSWORD), false);
  assert.equal(await verifyPassword(environment.SUPER_ADMIN_PASSWORD, result.rows[0].password_hash), true);
  await pool.end();
});

test('repeat bootstrap refuses to overwrite an existing admin', async () => {
  const poolFactory = await createPoolFactory();
  const options = { poolFactory, logger: { info() {} } };
  await bootstrapAdmin(environment, options);

  await assert.rejects(
    bootstrapAdmin(environment, options),
    /already exists; bootstrap does not overwrite passwords/,
  );

  const pool = poolFactory();
  const result = await pool.query('SELECT COUNT(*)::int AS total FROM super_admin_users');
  assert.equal(result.rows[0].total, 1);
  await pool.end();
});

test('bootstrap rejects passwords below the configured minimum before connecting', async () => {
  let connectAttempted = false;
  await assert.rejects(
    bootstrapAdmin(
      { ...environment, SUPER_ADMIN_PASSWORD: 'too-short' },
      { poolFactory: () => { connectAttempted = true; throw new Error('unexpected connection'); } },
    ),
    /at least 12 characters/,
  );
  assert.equal(connectAttempted, false);
});