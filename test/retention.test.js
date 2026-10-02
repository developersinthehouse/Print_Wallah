const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { cleanupCompletedOrderFiles } = require('../src/services/retention');

function makePool(order, sourceNames, photoNames) {
  return {
    async connect() {
      return {
        async query(sql, values) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('SELECT id, upload_id, print_file_name')) {
            return order.orderStatus !== 'completed' || order.filesDeletedAt || order.completedAt > values[0] ? { rows: [] } : { rows: [{
              id: order.id,
              upload_id: order.uploadId,
              print_file_name: order.printFileName,
            }] };
          }
          if (sql.includes('SELECT stored_name FROM uploads WHERE id = $1')) {
            return { rows: [...sourceNames, ...photoNames].map((stored_name) => ({ stored_name })) };
          }
          if (sql.includes('UPDATE orders SET files_deleted_at')) {
            order.filesDeletedAt = values[1];
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL in retention test: ${sql}`);
        },
        release() {},
      };
    },
  };
}

test('completed order files are removed after ten minutes while order metadata remains', async () => {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-retention-'));
  const now = new Date('2026-10-02T12:10:01.000Z');
  const names = ['source.pdf', 'photo-2.jpg', 'photo-sheet.pdf'];
  const order = {
    id: 'order-1',
    uploadId: 'upload-1',
    printFileName: 'photo-sheet.pdf',
    orderStatus: 'completed',
    completedAt: new Date(now.getTime() - 10 * 60 * 1000),
    filesDeletedAt: null,
  };
  try {
    await Promise.all(names.map((name) => fs.writeFile(path.join(uploadDir, name), 'print test data')));
    const pool = makePool(order, ['source.pdf'], ['photo-2.jpg']);
    const result = await cleanupCompletedOrderFiles({
      pool,
      uploadDir,
      now,
    });

    assert.deepEqual(result, { ordersDeleted: 1, filesDeleted: 3 });
    assert.equal(order.filesDeletedAt.toISOString(), now.toISOString());
    for (const name of names) await assert.rejects(fs.stat(path.join(uploadDir, name)), { code: 'ENOENT' });
    assert.deepEqual(await cleanupCompletedOrderFiles({ pool, uploadDir, now }), { ordersDeleted: 0, filesDeleted: 0 });
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});

test('completed-order cleanup does not delete files before the ten-minute boundary', async () => {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-retention-'));
  const now = new Date('2026-10-02T12:09:59.000Z');
  const order = {
    id: 'order-2',
    uploadId: 'upload-2',
    printFileName: null,
    orderStatus: 'completed',
    completedAt: new Date(now.getTime() - 9 * 60 * 1000 - 59 * 1000),
    filesDeletedAt: null,
  };
  try {
    await fs.writeFile(path.join(uploadDir, 'source.pdf'), 'print test data');
    const result = await cleanupCompletedOrderFiles({
      pool: makePool(order, ['source.pdf'], []),
      uploadDir,
      now,
    });

    assert.deepEqual(result, { ordersDeleted: 0, filesDeleted: 0 });
    assert.equal(order.filesDeletedAt, null);
    assert.equal(await fs.readFile(path.join(uploadDir, 'source.pdf'), 'utf8'), 'print test data');
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});

test('failed orders retain their files for retry', async () => {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-retention-'));
  const now = new Date('2026-10-02T12:20:00.000Z');
  const order = {
    id: 'order-failed',
    uploadId: 'upload-failed',
    printFileName: null,
    orderStatus: 'failed',
    completedAt: new Date(now.getTime() - 30 * 60 * 1000),
    filesDeletedAt: null,
  };
  try {
    await fs.writeFile(path.join(uploadDir, 'source.pdf'), 'retry data');
    const result = await cleanupCompletedOrderFiles({
      pool: makePool(order, ['source.pdf'], []),
      uploadDir,
      now,
    });

    assert.deepEqual(result, { ordersDeleted: 0, filesDeleted: 0 });
    assert.equal(await fs.readFile(path.join(uploadDir, 'source.pdf'), 'utf8'), 'retry data');
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});