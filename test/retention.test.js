const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { cleanupCompletedOrderFiles } = require('../src/services/retention');
const { createFileStorage } = require('../src/services/fileStorage');

function makeDb(order, uploads = []) {
  const docs = { orders: new Map([[order.id, order]]), uploads: new Map(uploads.map((upload) => [upload.id, upload])) };
  function snapshot(collection, id, data) {
    return {
      id, exists: Boolean(data), data: () => data,
      ref: { async update(patch) { Object.assign(data, patch); } },
    };
  }
  return {
    collection(name) {
      const map = docs[name] || new Map();
      return {
        doc(id) { return { async get() { return snapshot(name, String(id), map.get(String(id))); } }; },
        where(field, operator, value) {
          return query(map, [[field, operator, value]]);
        },
      };
    },
  };
  function query(map, filters, max = Infinity) {
    const api = {
      where(field, operator, value) { return query(map, [...filters, [field, operator, value]], max); },
      orderBy() { return api; },
      limit(count) { return query(map, filters, count); },
      async get() {
        const matched = [...map.entries()].filter(([, data]) => filters.every(([field, operator, value]) => {
          if (operator === '==') return data[field] === value;
          if (operator === '<=') return data[field] <= value;
          return false;
        })).slice(0, max);
        return { size: matched.length, docs: matched.map(([id, data]) => snapshot('orders', id, data)) };
      },
    };
    return api;
  }
}

async function withStorage(files, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-retention-'));
  try {
    await Promise.all(files.map((name) => fs.writeFile(path.join(directory, name), 'print test data')));
    return await run(directory, createFileStorage({ environment: { STORAGE_PROVIDER: 'local', UPLOAD_DIR: directory } }));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const old = (now, minutes = 10) => new Date(now.getTime() - minutes * 60 * 1000).toISOString();

test('completed order source and generated files are removed while order metadata remains', async () => {
  const now = new Date('2026-10-02T12:10:01.000Z');
  const order = { id: 'order-1', upload_id: 'upload-1', upload_ids: ['upload-2'], print_file_name: 'photo-sheet.pdf', order_status: 'completed', completed_at: old(now), files_deleted_at: null };
  await withStorage(['source.pdf', 'photo-2.jpg', 'photo-sheet.pdf'], async (directory, storage) => {
    const db = makeDb(order, [{ id: 'upload-1', stored_name: 'source.pdf' }, { id: 'upload-2', stored_name: 'photo-2.jpg' }]);
    assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 1, filesDeleted: 3 });
    assert.equal(order.files_deleted_at, now.toISOString());
    for (const name of ['source.pdf', 'photo-2.jpg', 'photo-sheet.pdf']) await assert.rejects(fs.stat(path.join(directory, name)), { code: 'ENOENT' });
    assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 0, filesDeleted: 0 });
  });
});

test('completed order files are eligible for cleanup immediately', async () => {
  const now = new Date('2026-10-02T12:00:00.000Z');
  const order = { id: 'order-2', upload_id: 'upload-2', print_file_name: null, order_status: 'completed', completed_at: now.toISOString(), files_deleted_at: null };
  await withStorage(['source.pdf'], async (directory, storage) => {
    const db = makeDb(order, [{ id: 'upload-2', stored_name: 'source.pdf' }]);
    assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 1, filesDeleted: 1 });
    await assert.rejects(fs.stat(path.join(directory, 'source.pdf')), { code: 'ENOENT' });
  });
});

test('failed orders retain files for retry', async () => {
  const now = new Date('2026-10-02T12:20:00.000Z');
  const order = { id: 'order-failed', upload_id: 'upload-failed', order_status: 'failed', completed_at: old(now, 30), files_deleted_at: null };
  await withStorage(['source.pdf'], async (directory, storage) => {
    const db = makeDb(order, [{ id: 'upload-failed', stored_name: 'source.pdf' }]);
    assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 0, filesDeleted: 0 });
    assert.equal(await fs.readFile(path.join(directory, 'source.pdf'), 'utf8'), 'print test data');
  });
});

test('unsafe filenames are skipped without blocking completed-order cleanup', async () => {
  const now = new Date('2026-10-02T12:20:00.000Z');
  const order = { id: 'order-unsafe', upload_id: 'upload-unsafe', order_status: 'completed', completed_at: old(now), files_deleted_at: null };
  const outsidePath = path.join(os.tmpdir(), 'print-wallah-retention-unsafe-test.txt');
  await fs.writeFile(outsidePath, 'must not be deleted');
  try {
    await withStorage(['safe.pdf'], async (directory, storage) => {
      const db = makeDb(order, [{ id: 'upload-unsafe', stored_name: '../print-wallah-retention-unsafe-test.txt' }]);
      assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 1, filesDeleted: 0 });
      assert.equal(await fs.readFile(outsidePath, 'utf8'), 'must not be deleted');
      assert.deepEqual(await cleanupCompletedOrderFiles({ db, storage, now }), { ordersDeleted: 0, filesDeleted: 0 });
    });
  } finally { await fs.rm(outsidePath, { force: true }); }
});
