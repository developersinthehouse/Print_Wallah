const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { after, before, test } = require('node:test');
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const { newDb } = require('pg-mem');
const { hashPassword } = require('../adminSessionRoutes');
const { runMigrations } = require('../db/migrate');
const customerRouter = require('../routes/customerRoutes');
const { createApp } = require('../server');

const SHOP_SECRET = 'server-test-shop-jwt-secret-with-more-than-32-bytes';
const ADMIN_SECRET = 'server-test-admin-jwt-secret-with-more-than-32-bytes';
const PAYMENT_SECRET = 'server-test-payment-webhook-secret-over-32-bytes';
let pool;
let server;
let baseUrl;
let customerOrderId;
let photoOrderId;

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
  const app = createApp({ pool, configuration, logger: { error() { } } });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const orderId of [customerOrderId, photoOrderId]) {
    if (orderId) {
      const result = await pool.query('SELECT storage_key FROM print_jobs WHERE id = $1', [orderId]);
      if (result.rows[0]?.storage_key) {
        await fs.unlink(path.join(customerRouter.uploadDirectory, result.rows[0].storage_key)).catch(() => { });
      }
    }
  }
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
  assert.equal(typeof onboarded.shopAdminSetupToken, 'string');
  assert.equal((await fetch(`${baseUrl}/start?shopId=${shopId}`)).status, 200);
  const homePage = await fetch(baseUrl);
  assert.equal(homePage.status, 200);
  assert.match(await homePage.text(), /QuickPrint \| Print locally/);
  const invalidShopLogin = await apiRequest('/api/shop-auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ shopId, email: 'owner@example.com', password: 'wrong-password' }),
  });
  assert.equal(invalidShopLogin.status, 401);
  assert.deepEqual(await invalidShopLogin.json(), { error: 'INVALID_SHOP_CREDENTIALS' });
  const setupResponse = await apiRequest('/api/shop-auth/setup', null, {
    method: 'POST',
    body: JSON.stringify({
      shopId,
      email: 'owner@example.com',
      setupToken: onboarded.shopAdminSetupToken,
      password: 'secure-shop-password',
    }),
  });
  assert.equal(setupResponse.status, 200);
  assert.equal((await setupResponse.json()).shopId, shopId);
  const replayedSetup = await apiRequest('/api/shop-auth/setup', null, {
    method: 'POST',
    body: JSON.stringify({
      shopId,
      email: 'owner@example.com',
      setupToken: onboarded.shopAdminSetupToken,
      password: 'another-secure-password',
    }),
  });
  assert.equal(replayedSetup.status, 400);
  const shopLoginResponse = await apiRequest('/api/shop-auth/login', null, {
    method: 'POST',
    body: JSON.stringify({
      shopId,
      email: 'owner@example.com',
      password: 'secure-shop-password',
    }),
  });
  assert.equal(shopLoginResponse.status, 200);
  const { accessToken: shopToken } = await shopLoginResponse.json();
  const settingsResponse = await apiRequest(`/api/shops/${shopId}/settings`, shopToken, {
    method: 'PUT',
    body: JSON.stringify({
      rates: { blackAndWhitePerPage: 2, colorPerPage: 8 },
      upiId: 'owner@upi',
      printOptions: {
        documentEnabled: true,
        photoEnabled: true,
        photoPrice: 20,
        glossyEnabled: true,
        glossySurchargePerPage: 5,
      },
    }),
  });
  assert.equal(settingsResponse.status, 200);
  const customerShopResponse = await fetch(`${baseUrl}/api/customer/shops/${shopId}`);
  assert.equal(customerShopResponse.status, 200);
  assert.deepEqual((await customerShopResponse.json()).shop, {
    id: shopId,
    name: 'Integrated Shop',
    upiVpa: 'owner@upi',
    rates: { bw: 2, color: 8 },
    printOptions: {
      documentEnabled: true,
      photoEnabled: true,
      photoPrice: 20,
      glossyEnabled: true,
      glossySurchargePerPage: 5,
    },
  });
  const agentTokenResponse = await apiRequest(`/api/shops/${shopId}/agent-tokens`, shopToken, {
    method: 'POST',
    body: JSON.stringify({ label: 'Test print station' }),
  });
  assert.equal(agentTokenResponse.status, 201);
  const agentTokenBody = await agentTokenResponse.json();
  const agentToken = agentTokenBody.token.secret;
  const listedAgentTokens = await apiRequest(`/api/shops/${shopId}/agent-tokens`, shopToken);
  assert.equal((await listedAgentTokens.json()).tokens.length, 1);
  const agentDashboardResponse = await apiRequest(`/api/shops/${shopId}/dashboard`, agentToken);
  assert.equal(agentDashboardResponse.status, 403);
  const agentRateUpdate = await apiRequest(`/api/shops/${shopId}/rates`, agentToken, {
    method: 'PUT',
    body: JSON.stringify({ blackAndWhitePerPage: 1, colorPerPage: 2 }),
  });
  assert.equal(agentRateUpdate.status, 403);

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

  const reportResponse = await apiRequest(`/api/shops/${shopId}/print-jobs/integrated-job/status`, agentToken, {
    method: 'POST',
    body: JSON.stringify({ status: 'PRINTED' }),
  });
  assert.equal(reportResponse.status, 200);
  const adminReportResponse = await apiRequest(`/api/shops/${shopId}/print-jobs/integrated-job/status`, shopToken, {
    method: 'POST',
    body: JSON.stringify({ status: 'PRINTED' }),
  });
  assert.equal(adminReportResponse.status, 403);

  const orderForm = new FormData();
  orderForm.set('shopId', shopId);
  orderForm.set('pageCount', '2');
  orderForm.set('copies', '2');
  orderForm.set('colorMode', 'bw');
  const pdfDocument = await PDFDocument.create();
  pdfDocument.addPage();
  pdfDocument.addPage();
  const pdfBytes = await pdfDocument.save();
  orderForm.set('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'customer-order.pdf');
  const customerOrderResponse = await fetch(`${baseUrl}/api/customer/orders`, {
    method: 'POST',
    body: orderForm,
  });
  assert.equal(customerOrderResponse.status, 201);
  const customerOrder = await customerOrderResponse.json();
  customerOrderId = customerOrder.order.orderId;
  assert.equal(customerOrder.order.pageCount, 2);
  assert.equal(new URL(customerOrder.order.upiUrl).searchParams.get('pa'), 'owner@upi');

  const photoForm = new FormData();
  photoForm.set('shopId', shopId);
  photoForm.set('pageCount', '1');
  photoForm.set('copies', '2');
  photoForm.set('colorMode', 'color');
  photoForm.set('printType', 'photo');
  photoForm.set('paperFinish', 'glossy');
  photoForm.set('file', new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'photo.png');
  const photoResponse = await fetch(`${baseUrl}/api/customer/orders`, {
    method: 'POST',
    body: photoForm,
  });
  assert.equal(photoResponse.status, 201);
  const photoOrder = await photoResponse.json();
  photoOrderId = photoOrder.order.orderId;
  assert.equal(photoOrder.order.amount, 50);
  assert.equal(photoOrder.order.printType, 'photo');
  assert.equal(photoOrder.order.paperFinish, 'glossy');

  const forgedOrderForm = new FormData();
  forgedOrderForm.set('shopId', shopId);
  forgedOrderForm.set('pageCount', '1');
  forgedOrderForm.set('copies', '1');
  forgedOrderForm.set('colorMode', 'bw');
  forgedOrderForm.set('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'underreported-order.pdf');
  const forgedOrderResponse = await fetch(`${baseUrl}/api/customer/orders`, {
    method: 'POST',
    body: forgedOrderForm,
  });
  assert.equal(forgedOrderResponse.status, 400);

  const pendingResponse = await apiRequest(
    `/api/shops/${shopId}/print-jobs?status=AWAITING_PAYMENT`,
    shopToken,
  );
  const pendingJobs = (await pendingResponse.json()).jobs;
  const pendingJob = pendingJobs.find((job) => job.id === customerOrderId);
  assert.ok(pendingJob);
  assert.equal(pendingJob.copies, 2);

  const pendingFileResponse = await apiRequest(pendingJob.fileUrl, agentToken);
  assert.equal(pendingFileResponse.status, 404);
  const forbiddenConfirmation = await apiRequest(
    `/api/shops/${shopId}/print-jobs/${customerOrderId}/payment-confirmation`,
    agentToken,
    { method: 'POST', body: JSON.stringify({ paymentReference: 'UPI-REF-123456' }) },
  );
  assert.equal(forbiddenConfirmation.status, 403);

  const confirmationResponse = await apiRequest(
    `/api/shops/${shopId}/print-jobs/${customerOrderId}/payment-confirmation`,
    shopToken,
    { method: 'POST', body: JSON.stringify({ paymentReference: 'UPI-REF-123456' }) },
  );
  assert.equal(confirmationResponse.status, 200);
  const readyJobsResponse = await apiRequest(
    `/api/shops/${shopId}/print-jobs?status=READY_TO_PRINT`,
    agentToken,
  );
  const readyJobs = (await readyJobsResponse.json()).jobs;
  const customerJob = readyJobs.find((job) => job.id === customerOrderId);
  assert.ok(customerJob);

  const customerFileResponse = await apiRequest(customerJob.fileUrl, agentToken);
  assert.equal(customerFileResponse.status, 200);
  assert.match(await customerFileResponse.text(), /^%PDF-/);
  const customerPrintResult = await apiRequest(
    `/api/shops/${shopId}/print-jobs/${customerOrderId}/status`,
    agentToken,
    { method: 'POST', body: JSON.stringify({ status: 'PRINTED' }) },
  );
  assert.equal(customerPrintResult.status, 200);

  const revokeTokenResponse = await apiRequest(
    `/api/shops/${shopId}/agent-tokens/${agentTokenBody.token.id}`,
    shopToken,
    { method: 'DELETE' },
  );
  assert.equal(revokeTokenResponse.status, 204);
  const revokedAgentRequest = await apiRequest(
    `/api/shops/${shopId}/print-jobs?status=READY_TO_PRINT`,
    agentToken,
  );
  assert.equal(revokedAgentRequest.status, 401);

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
  assert.equal((await fetch(`${baseUrl}/assets/pw_logo.jpeg`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/assets/developers-logo_nobg.webp`)).status, 200);
});
