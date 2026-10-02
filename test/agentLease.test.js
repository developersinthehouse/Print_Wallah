const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const { createAgentLeaseRouter } = require('../src/routes/agentLease');

const TOKEN = 'test-agent-lease-token';
const SHOP_PUBLIC_ID = 'SHOPPUBLIC1';
const SHOP_ID = 'shop-internal-id';
let leaseActive = true;
let leaseUpdates = 0;
let server;
let baseUrl;

const pool = {
  async query(sql, values) {
    if (sql.includes('SELECT id FROM shops')) {
      const tokenHash = crypto.createHash('sha256').update(TOKEN).digest('hex');
      return values[0] === SHOP_PUBLIC_ID && values[1] === tokenHash
        ? { rows: [{ id: SHOP_ID }] }
        : { rows: [] };
    }
    if (sql.includes('UPDATE print_jobs')) {
      if (!leaseActive || values[0] !== 'job-1' || values[1] !== SHOP_ID) return { rows: [] };
      leaseUpdates += 1;
      return { rows: [{ id: 'job-1' }] };
    }
    if (sql.includes('UPDATE shops')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  },
};

before(async () => {
  const app = express();
  app.use('/api/agent/:shopId', createAgentLeaseRouter(pool));
  app.use((error, request, response, next) => response.status(500).json({ error: error.message }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('agent token renews only an active lease belonging to its shop', async () => {
  const missingToken = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/job-1/heartbeat`, { method: 'POST' });
  assert.equal(missingToken.status, 401);

  const otherShop = await fetch(`${baseUrl}/api/agent/OTHER/jobs/job-1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(otherShop.status, 401);

  const renewed = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/job-1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), { ok: true });
  assert.equal(leaseUpdates, 1);

  leaseActive = false;
  const expired = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/job-1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(expired.status, 409);
  assert.deepEqual(await expired.json(), { error: 'Job lease is no longer active' });
});