const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cleanupExpiredUploads } = require('../src/services/uploadRetention');

function makeDb(uploads, claims = []) {
  const uploadRows = new Map(uploads.map((row) => [row.id, structuredClone(row)]));
  const claimRows = new Map(claims.map((id) => [id, { order_id: `order-${id}` }]));
  const ref = (collection, id) => ({
    id: String(id),
    collectionName: collection,
    async get() {
      const row = (collection === 'uploads' ? uploadRows : claimRows).get(String(id));
      return { id: String(id), exists: row !== undefined, data: () => row && structuredClone(row) };
    },
  });
  const db = {
    collection(name) {
      return {
        doc(id) {
          const document = ref(name, id);
          return {
            ...document,
            async get() { return document.get(); },
          };
        },
        where(field, operator, value) {
          let limit = Infinity;
          const query = {
            orderBy() { return query; },
            limit(count) { limit = count; return query; },
            async get() {
              const docs = [...uploadRows.values()]
                .filter((row) => operator === '<=' && row[field] <= value)
                .slice(0, limit)
                .map((row) => ({ id: row.id, ref: ref(name, row.id) }));
              return { docs };
            },
          };
          return query;
        },
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get(documentRef) { return documentRef.get(); },
        update(documentRef, patch) { writes.push(['update', documentRef, patch]); },
        delete(documentRef) { writes.push(['delete', documentRef]); },
      };
      const result = await callback(transaction);
      for (const [operation, documentRef, patch] of writes) {
        const collectionName = documentRef.collectionName;
        const target = collectionName === 'uploads' ? uploadRows : claimRows;
        if (operation === 'delete') target.delete(documentRef.id);
        else Object.assign(target.get(documentRef.id), patch);
      }
      return result;
    },
  };
  return { db, uploadRows, claimRows };
}

const expired = (id) => ({ id, stored_name: `${id}.pdf`, expires_at: '2026-10-01T00:00:00.000Z' });
const now = new Date('2026-10-02T00:00:00.000Z');

test('expired upload metadata stays retryable when R2 object deletion fails', async () => {
  const { db, uploadRows } = makeDb([expired('upload-retry')]);
  let failOnce = true;
  const deleted = [];
  const storage = { async delete(name) { if (failOnce) { failOnce = false; throw new Error('Storage temporarily unavailable'); } deleted.push(name); } };

  await assert.rejects(cleanupExpiredUploads({ db, storage, now }), /temporarily unavailable/);
  assert.equal(uploadRows.get('upload-retry').cleanup_pending, true);
  assert.deepEqual(deleted, []);

  assert.deepEqual(await cleanupExpiredUploads({ db, storage, now }), { uploadsDeleted: 1 });
  assert.equal(uploadRows.has('upload-retry'), false);
  assert.deepEqual(deleted, ['upload-retry.pdf']);
});

test('expired upload with an order claim is never removed', async () => {
  const { db, uploadRows } = makeDb([expired('upload-claimed')], ['upload-claimed']);
  let deleteCalls = 0;
  const result = await cleanupExpiredUploads({ db, now, storage: { async delete() { deleteCalls += 1; } } });
  assert.deepEqual(result, { uploadsDeleted: 0 });
  assert.equal(deleteCalls, 0);
  assert.equal(uploadRows.has('upload-claimed'), true);
});
