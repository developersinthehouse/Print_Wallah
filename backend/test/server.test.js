const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { newDb } = require('pg-mem');
const { hashPassword } = require('../adminSessionRoutes');
const { runMigrations } = require('../db/migrate');
const { createApp } = require('../server');

const SHOP_SECRET = 'server-test-shop-jwt-secret-with-more-than-32-bytes';
const ADMIN_SECRET = 'server-test-admin-jwt-secret-with-more-than-32-bytes';
const PAYMENT_SECRET = 'server-test-payment-webhook-secret-over-32-bytes';
let pool;
let server;
let baseUrl;

function makeToken(role, shopId) {
  const options = {
    issuer: role === 'SUPER_ADMIN' ? 'developers-test' : 'shops-test',
    audience: role === 'SUPER_ADMIN' ? 'developers-admin' : 'shop-users',
    expiresIn: '5m',
    algorithm: 'HS256',
  };
  if (role === 'SUPER_ADMIN') options.subject = 'admin-1';
  return jwt.sign(
    { role, ...(shopId ? { shopId } : {}) },
    role === 'SUPER_ADMIN' ? ADMIN_SECRET : SHOP_SECRET,
    options,
  );
}

async function apiRequest(path, token, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

before(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  pool = new Pool();
  await runMigrations(pool);
  await pool.query(
    'INSERT INTO super_admin_users (id, email, password_hash) VALUES ($1, $2, $3)',
    ['admin-1', 'admin@example.com', await hashPassword('integration-admin-password')],
  );
  const configuration = {
    port: 0,
    databaseUrl: 'postgres://test',
    databaseSsl: false,
    shopJwtSecret: SHOP_SECRET,
    shopJwtIssuer: 'shops-test',
    shopJwtAudience: 'shop-users',
    superAdminJwtSecret: ADMIN_SECRET,
    superAdminJwtIssuer: 'developers-test',
    superAdminJwtAudience: 'developers-admin',
    paymentWebhookSecret: PAYMENT_SECRET,
    onboardingBaseUrl: 'https://print.example.com/start',
    planDurationsDays: { monthly: 30 },
  };
  const app = createApp({ pool, configuration, logger: { error() {} } });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
});

test('server mounts auth, onboarding, shop operations, renewals, and static admin views', async () => {
  const healthResponse = await fetch(`${baseUrl}/healthz`);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', database: 'connected' });

  const unauthorized = await apiRequest('/api/shops/shop-1/print-jobs', null);
  assert.equal(unauthorized.status, 401);

  const loginResponse = await apiRequest('/api/admin-auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'ADMIN@example.com', password: 'integration-admin-password' }),
  });
  assert.equal(loginResponse.status, 200);
  const { accessToken: adminToken } = await loginResponse.json();
  const onboardingResponse = await apiRequest('/api/admin/shops', adminToken, {
    method: 'POST',
    body: JSON.stringify({
      shopName: 'Integrated Shop',
      ownerName: 'Shop Owner',
      ownerEmail: 'owner@example.com',
      planId: 'monthly',
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
    }),
  });
  assert.equal(onboardingResponse.status, 201);
  const onboarded = await onboardingResponse.json();
  const shopId = onboarded.shop.id;
  assert.match(onboarded.shopAdminSetupToken, /^[A-Za-z0-9_-]{43}$/);
  const activationResponse = await apiRequest('/api/shop-auth/setup', null, {
    method: 'POST',
    body: JSON.stringify({
      shopId,
      email: 'owner@example.com',
      setupToken: onboarded.shopAdminSetupToken,
      password: 'integrated-shop-owner-password',
    }),
  });
  assert.equal(activationResponse.status, 200);
  const shopSession = await activationResponse.json();
  assert.equal(shopSession.shopId, shopId);
  const shopToken = shopSession.accessToken;

  const dashboardResponse = await apiRequest(`/api/shops/${shopId}/dashboard`, shopToken);
  assert.equal(dashboardResponse.status, 200);
  assert.deepEqual((await dashboardResponse.json()).rates, {
    blackAndWhitePerPage: 2,
    colorPerPage: 8,
  });

  await pool.query(
    `INSERT INTO print_jobs (id, shop_id, file_url, page_count, total_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ['integrated-job', shopId, 'https://files.example.com/print.pdf', 1, 2, 'READY_TO_PRINT'],
  );
  const jobsResponse = await apiRequest(`/api/shops/${shopId}/print-jobs?status=READY_TO_PRINT`, shopToken);
  assert.equal((await jobsResponse.json()).jobs[0].fileUrl, 'https://files.example.com/print.pdf');

  const reportResponse = await apiRequest(`/api/shops/${shopId}/print-jobs/integrated-job/status`, shopToken, {
    method: 'POST',
    body: JSON.stringify({ status: 'PRINTED' }),
  });
  assert.equal(reportResponse.status, 200);

  const paymentPayload = {
    event: 'payment.captured',
    status: 'PAID',
    paymentId: 'integrated-payment',
    shopId,
    planId: 'monthly',
  };
  const rawBody = Buffer.from(JSON.stringify(paymentPayload));
  const signature = crypto.createHmac('sha256', PAYMENT_SECRET).update(rawBody).digest('hex');
  const paymentResponse = await fetch(`${baseUrl}/api/subscriptions/payment-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': `sha256=${signature}` },
    body: rawBody,
  });
  assert.equal(paymentResponse.status, 200);

  const adminPage = await fetch(`${baseUrl}/super-admin`);
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /DEVELOPERS/);
  const shopPage = await fetch(`${baseUrl}/shop-admin`);
  assert.equal(shopPage.status, 200);
  assert.match(await shopPage.text(), /shop-login-form/);
});