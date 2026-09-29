const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { newDb } = require('pg-mem');
const { runMigrations } = require('../db/migrate');
const { createShopSessionRouter } = require('../shopSessionRoutes');

const SHOP_SECRET = 'shop-session-test-signing-secret-with-more-than-32-bytes';
let pool;
let server;
let baseUrl;

async function request(path, body) {
  return fetch(`${baseUrl}/api/shop-auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  pool = new Pool();
  await runMigrations(pool);
  await pool.query(
    `INSERT INTO shop_profiles
      (id, shop_name, owner_name, owner_email, black_and_white_per_page, color_per_page,
       subscription_expiry_date, subscription_status)
     VALUES ('shop-auth-1', 'Auth Shop', 'Owner', 'owner@example.com', 2, 8, $1, 'ACTIVE')`,
    [new Date(Date.now() + 86400000)],
  );
  const { createHash, randomBytes } = require('node:crypto');
  const setupToken = randomBytes(32).toString('base64url');
  const setupTokenHash = createHash('sha256').update(setupToken).digest('hex');
  await pool.query(
    `INSERT INTO shop_admin_credentials (shop_id, setup_token_hash, setup_expires_at)
     VALUES ($1, $2, $3)`,
    ['shop-auth-1', setupTokenHash, new Date(Date.now() + 86400000)],
  );
  const app = express();
  app.use('/api/shop-auth', createShopSessionRouter({
    pool,
    jwtSecret: SHOP_SECRET,
    issuer: 'print-wallah-tests',
    audience: 'shop-users',
  }));
  app.use((error, request, response, next) => response.status(500).json({ error: error.message }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  globalThis.shopSetupToken = setupToken;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('shop owner activates once and can sign in with a shop-scoped token', async () => {
  const password = 'long-enough-shop-password';
  const setupResponse = await request('/setup', {
    shopId: 'shop-auth-1',
    email: 'OWNER@example.com',
    setupToken: globalThis.shopSetupToken,
    password,
  });
  assert.equal(setupResponse.status, 200);
  const setupBody = await setupResponse.json();
  assert.equal(setupBody.shopId, 'shop-auth-1');
  assert.equal(jwt.verify(setupBody.accessToken, SHOP_SECRET).role, 'SHOP_ADMIN');
  assert.equal(jwt.verify(setupBody.accessToken, SHOP_SECRET).shopId, 'shop-auth-1');

  const replayResponse = await request('/setup', {
    shopId: 'shop-auth-1', email: 'owner@example.com', setupToken: globalThis.shopSetupToken, password,
  });
  assert.equal(replayResponse.status, 400);

  const loginResponse = await request('/login', {
    shopId: 'shop-auth-1', email: 'owner@example.com', password,
  });
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).shopId, 'shop-auth-1');

  const invalidResponse = await request('/login', {
    shopId: 'shop-auth-1', email: 'owner@example.com', password: 'incorrect-password',
  });
  assert.equal(invalidResponse.status, 401);
  assert.deepEqual(await invalidResponse.json(), { error: 'INVALID_SHOP_CREDENTIALS' });
});