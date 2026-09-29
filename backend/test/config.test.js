const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadConfiguration, parsePlanDurations } = require('../config');

function validEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://print_wallah:local-password@localhost:5432/print_wallah',
    DATABASE_SSL: 'false',
    PORT: '3000',
    SHOP_JWT_SECRET: 'shop-secret-with-at-least-32-random-bytes',
    SUPER_ADMIN_JWT_SECRET: 'admin-secret-with-at-least-32-random-bytes',
    PAYMENT_WEBHOOK_SECRET: 'payment-secret-with-at-least-32-random-bytes',
    PRINT_WALLAH_ONBOARDING_URL: 'https://print.example.com/start',
    SUBSCRIPTION_PLANS: 'monthly:30,annual:365',
    ...overrides,
  };
}

test('configuration accepts PostgreSQL URLs, distinct secrets, and configured plans', () => {
  const configuration = loadConfiguration(validEnvironment());

  assert.equal(configuration.databaseUrl, 'postgresql://print_wallah:local-password@localhost:5432/print_wallah');
  assert.equal(configuration.port, 3000);
  assert.deepEqual(configuration.planDurationsDays, { monthly: 30, annual: 365 });
});

test('configuration rejects missing or non-PostgreSQL database URLs', () => {
  assert.throws(() => loadConfiguration(validEnvironment({ DATABASE_URL: '' })), /DATABASE_URL/);
  assert.throws(() => loadConfiguration(validEnvironment({ DATABASE_URL: 'https://db.example.com' })), /PostgreSQL/);
});

test('configuration rejects weak or repeated authentication secrets', () => {
  assert.throws(() => loadConfiguration(validEnvironment({ SHOP_JWT_SECRET: 'short' })), /32 bytes/);
  assert.throws(
    () => loadConfiguration(validEnvironment({ PAYMENT_WEBHOOK_SECRET: 'shop-secret-with-at-least-32-random-bytes' })),
    /must be distinct/,
  );
});

test('configuration requires a valid onboarding URL and supported SSL mode', () => {
  assert.throws(
    () => loadConfiguration(validEnvironment({ PRINT_WALLAH_ONBOARDING_URL: 'javascript:alert(1)' })),
    /HTTP\(S\)/,
  );
  assert.throws(() => loadConfiguration(validEnvironment({ DATABASE_SSL: 'yes' })), /DATABASE_SSL/);
});

test('plan configuration rejects duplicates, invalid durations, and invalid IDs', () => {
  assert.throws(() => parsePlanDurations('monthly:30,monthly:365'), /unique/);
  assert.throws(() => parsePlanDurations('monthly:0'), /unique planId/);
  assert.throws(() => parsePlanDurations(''), /at least one plan/);
});