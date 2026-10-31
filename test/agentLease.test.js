const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, test } = require('node:test');
const express = require('express');
const { createAgentLeaseRouter } = require('../src/routes/agentLease');

const TOKEN = 'test-agent-lease-token';
const SHOP_PUBLIC_ID = 'SHOPPUBLIC1';
const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
let leaseUpdates = 0;
let server;
let baseUrl;

function fakeDb() {
  const collections = {
    shops: new Map([[SHOP_ID, { public_id: SHOP_PUBLIC_ID, agent_token_hash: crypto.createHash('sha256').update(TOKEN).digest('hex') }]]),
    print_jobs: new Map([[JOB_ID, { shop_id: SHOP_ID, claimed_by: 'print-agent', status: 'claimed' }]]),
  };
  const refFor = (collection, id) => ({ id, async get() {
    const data = collections[collection].get(id);
    return { id, exists: Boolean(data), data: () => data };
  } });
  return {
    collection(name) {
      const map = collections[name];
      return {
        doc(id) { return refFor(name, String(id)); },
        where(field, operator, value) {
          const filters = [[field, operator, value]];
          const query = {
            where(nextField, nextOperator, nextValue) { filters.push([nextField, nextOperator, nextValue]); return query; },
            limit() { return query; },
            async get() {
              const docs = [...map.entries()].filter(([, data]) => filters.every(([key, , expected]) => data[key] === expected))
                .map(([id, data]) => ({ id, ref: refFor(name, id), data: () => data }));
              return { empty: docs.length === 0, docs };
            },
          };
          return query;
        },
      };
    },
    async runTransaction(work) {
      return work({
        get: (ref) => ref.get(),
        update(ref, patch) {
          const collection = Object.keys(collections).find((name) => collections[name].has(ref.id));
          if (collection) Object.assign(collections[collection].get(ref.id), patch);
          if (collection === 'print_jobs') leaseUpdates += 1;
        },
      });
    },
    expireLease() { collections.print_jobs.get(JOB_ID).status = 'completed'; },
  };
}
const db = fakeDb();

before(async () => {
  const app = express();
  app.use('/api/agent/:shopId', createAgentLeaseRouter({ db }));
  app.use((error, request, response, next) => response.status(500).json({ error: error.message }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('agent token renews only an active lease belonging to its shop', async () => {
  const invalidJobId = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/not-a-uuid/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(invalidJobId.status, 400);

  const missingToken = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/${JOB_ID}/heartbeat`, { method: 'POST' });
  assert.equal(missingToken.status, 401);

  const otherShop = await fetch(`${baseUrl}/api/agent/OTHER/jobs/${JOB_ID}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(otherShop.status, 401);

  const renewed = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/${JOB_ID}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), { ok: true });
  assert.equal(leaseUpdates, 1);

  db.expireLease();
  const expired = await fetch(`${baseUrl}/api/agent/${SHOP_PUBLIC_ID}/jobs/${JOB_ID}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(expired.status, 409);
  assert.deepEqual(await expired.json(), { error: 'Job lease is no longer active' });
});
