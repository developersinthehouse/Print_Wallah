const assert = require('node:assert/strict');
const { after } = require('node:test');
const { test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createSuperAdminSessionRouter, hashPassword, verifyPassword } = require('../adminSessionRoutes');

const JWT_SECRET = 'admin-session-test-secret-with-at-least-32-bytes';

async function createLoginServer(admin) {
  const pool = {
    async query(sql, values) {
      if (sql.startsWith('SELECT id, email, password_hash')) {
        const row = admin && admin.email === values[0] ? admin : null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE super_admin_users')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  const app = express();
  app.use('/api/admin-auth', createSuperAdminSessionRouter({
    pool,
    jwtSecret: JWT_SECRET,
    issuer: 'print-wallah-test',
    audience: 'developers-admin',
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/admin-auth/login`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

test('scrypt password hashes verify only the original password', async () => {
  const encodedHash = await hashPassword('a-secure-local-password');

  assert.match(encodedHash, /^scrypt\$/);
  assert.equal(await verifyPassword('a-secure-local-password', encodedHash), true);
  assert.equal(await verifyPassword('a-different-password', encodedHash), false);
  assert.equal(await verifyPassword('a-secure-local-password', 'invalid'), false);
  await assert.rejects(hashPassword('short'), /between 12 and 1024/);
});

test('valid admin login issues a role-scoped short-lived JWT', async (context) => {
  const admin = {
    id: 'admin-1',
    email: 'admin@example.com',
    password_hash: await hashPassword('a-secure-local-password'),
  };
  const instance = await createLoginServer(admin);
  context.after(instance.close);

  const response = await fetch(instance.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ' ADMIN@example.com ', password: 'a-secure-local-password' }),
  });
  const body = await response.json();
  const claims = jwt.verify(body.accessToken, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: 'print-wallah-test',
    audience: 'developers-admin',
  });

  assert.equal(response.status, 200);
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(body.expiresIn, 900);
  assert.equal(body.email, 'admin@example.com');
  assert.equal(claims.role, 'SUPER_ADMIN');
  assert.equal(claims.sub, 'admin-1');
});

test('invalid admin credentials return a generic response', async (context) => {
  const instance = await createLoginServer({
    id: 'admin-1',
    email: 'admin@example.com',
    password_hash: await hashPassword('a-secure-local-password'),
  });
  context.after(instance.close);

  const response = await fetch(instance.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'INVALID_ADMIN_CREDENTIALS' });
});

test('admin login rate-limits repeated failures from the same address', async (context) => {
  const instance = await createLoginServer(null);
  context.after(instance.close);
  const request = () => fetch(instance.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request()).status, 401);
  }
  const limited = await request();

  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'ADMIN_LOGIN_RATE_LIMITED' });
});