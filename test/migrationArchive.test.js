const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadArchive, toImportModel, importArchive } = require('../scripts/importFirestoreArchive');

const ids = {
  shop: 'shop-uuid', upload1: 'upload-uuid-1', upload2: 'upload-uuid-2', order: 'order-uuid',
};
const emptyTables = () => ({ shops: [], uploads: [], orders: [], payments: [], print_jobs: [], order_uploads: [], access_extensions: [], audit_log: [], payment_events: [] });
function fixtureTables() {
  const tables = emptyTables();
  tables.shops.push({ id: ids.shop, public_id: 'SHOP123456', name: 'Test Print', admin_email: 'admin@example.test', admin_password_hash: 'bcrypt-hash', pricing: '{"bw_a4":2}', print_config: '{"paperSizes":["A4"],"paperTypes":["normal"]}', access_start: '2026-01-01T00:00:00Z', access_end: '2027-01-01T00:00:00Z', manually_locked: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  for (const [id, name] of [[ids.upload1, 'one.pdf'], [ids.upload2, 'two.pdf']]) tables.uploads.push({ id, shop_id: ids.shop, public_token: `token-${id}`, original_name: name, stored_name: `${id}.pdf`, mime_type: 'application/pdf', byte_size: 4, page_count: 1, created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-01T02:00:00Z' });
  tables.orders.push({ id: ids.order, order_code: 'PR-ABC123-0123456789', shop_id: ids.shop, upload_id: ids.upload1, print_file_name: 'bundle.pdf', customer_name: null, config: { mode: 'document', fileName: '2 files', billablePages: 2 }, page_count: 2, copies: 1, amount: '4.00', payment_method: 'cash', payment_status: 'verified', order_status: 'print_queued', print_status: 'queued', created_at: '2026-10-01T00:01:00Z', updated_at: '2026-10-01T00:01:00Z', completed_at: null, files_deleted_at: null });
  tables.order_uploads.push({ order_id: ids.order, upload_id: ids.upload1, quantity: 1, position: 0 }, { order_id: ids.order, upload_id: ids.upload2, quantity: 1, position: 1 });
  tables.print_jobs.push({ id: 'legacy-job-id', order_id: ids.order, shop_id: ids.shop, queue_position: '7', status: 'queued', attempts: 0, claimed_by: null, claimed_at: null, created_at: '2026-10-01T00:01:00Z', updated_at: '2026-10-01T00:01:00Z' });
  tables.audit_log.push({ id: '42', shop_id: ids.shop, actor: 'owner', action: 'shop.created', details: '{}', created_at: '2026-01-01T00:00:00Z' });
  return tables;
}
function manifest(tables) {
  return { version: 1, archive_id: 'production-cutover-20261030', exported_at: '2026-10-30T12:00:00Z', counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])) };
}
async function withArchive(run, updateTables = () => {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-migration-'));
  try {
    const tables = fixtureTables();
    updateTables(tables);
    await fs.mkdir(path.join(directory, 'files'));
    for (const [id] of [[ids.upload1], [ids.upload2]]) await fs.writeFile(path.join(directory, 'files', `${id}.pdf`), '1234');
    await fs.writeFile(path.join(directory, 'files', 'bundle.pdf'), 'bundle');
    await fs.writeFile(path.join(directory, 'data.json'), JSON.stringify(tables));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest(tables)));
    await run(directory, tables);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
function fakeFirebase() {
  const collections = new Map();
  const objects = new Map();
  function mapFor(name) { if (!collections.has(name)) collections.set(name, new Map()); return collections.get(name); }
  const db = {
    collection(name) {
      const map = mapFor(name);
      return {
        doc(id) {
          const key = String(id);
          return {
            id: key,
            async get() { const data = map.get(key); return { id: key, exists: data !== undefined, data: () => structuredClone(data) }; },
            async create(data) { if (map.has(key)) throw Object.assign(new Error('already exists'), { code: 6 }); map.set(key, structuredClone(data)); },
            async update(data) { if (!map.has(key)) throw new Error('missing document'); Object.assign(map.get(key), structuredClone(data)); },
          };
        },
        limit() { return { async get() { const docs = [...map.entries()].slice(0, 1).map(([id, data]) => ({ id, data: () => structuredClone(data) })); return { empty: docs.length === 0, docs }; } }; },
      };
    },
    async runTransaction(callback) {
      const creates = [];
      const transaction = {
        async get(ref) { return ref.get(); },
        create(ref, data) { creates.push([ref, structuredClone(data)]); },
      };
      const result = await callback(transaction);
      for (const [ref, data] of creates) await ref.create(data);
      return result;
    },
  };
  const bucket = {
    async getFiles() { return [[...objects.keys()].map((name) => ({ name }))]; },
    file(name) {
      return {
        async exists() { return [objects.has(name)]; },
        async download() { if (!objects.has(name)) throw Object.assign(new Error('missing'), { code: 404 }); return [Buffer.from(objects.get(name))]; },
        async save(bytes) { if (objects.has(name)) throw Object.assign(new Error('precondition'), { code: 412 }); objects.set(name, Buffer.from(bytes)); },
      };
    },
  };
  return { db, bucket, projectId: 'firebase-test-project', collections, objects };
}

test('legacy rows map to Firebase document IDs and rebuild order, claims, payment, and queue lookups', () => {
  const docs = toImportModel(fixtureTables());
  assert.equal(docs.shops.get(ids.shop).pricing.bw_a4, 2);
  assert.equal(docs.orders.get(ids.order).amount, 4);
  assert.deepEqual(docs.orders.get(ids.order).items, [
    { upload_id: ids.upload1, quantity: 1, position: 0 },
    { upload_id: ids.upload2, quantity: 1, position: 1 },
  ]);
  assert.equal(docs.upload_order_claims.get(ids.upload1).order_id, ids.order);
  assert.equal(docs.upload_order_claims.get(ids.upload2).order_id, ids.order);
  assert.equal(docs.print_jobs.has(ids.order), true);
  assert.equal(docs.print_jobs.has('legacy-job-id'), false);
  assert.equal(docs.queue_counters.get(ids.shop).value, 7);
  assert.equal(docs.order_codes.get('PR-ABC123-0123456789').order_id, ids.order);
  assert.equal(docs.audit_log.has('42'), true);
});

test('archive dry run validates manifest counts and required active print files without Firebase credentials', async () => {
  await withArchive(async (directory) => {
    const result = await importArchive(directory, { apply: false });
    assert.equal(result.dryRun, true);
    assert.equal(result.summary.counts.orders, 1);
    assert.equal(result.summary.files, 3);
    assert.match(result.summary.archive_sha256, /^[a-f0-9]{64}$/);
  });
  await withArchive(async (directory) => {
    await fs.rm(path.join(directory, 'files', 'bundle.pdf'));
    await assert.rejects(loadArchive(directory), /Active\/retryable order file is missing/);
  });
  await withArchive(async (directory) => {
    const bytes = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
    await fs.writeFile(path.join(directory, 'manifest.json'), bytes.replace('"orders":1', '"orders":2'));
    await assert.rejects(loadArchive(directory), /row count for orders/);
  });
});

test('documented combined archive.json export loads and validates its embedded data', async () => {
  await withArchive(async (directory, tables) => {
    const sourceManifest = manifest(tables);
    const combined = { ...sourceManifest, data: tables };
    await fs.writeFile(path.join(directory, 'archive.json'), JSON.stringify(combined));
    await fs.rm(path.join(directory, 'manifest.json'));
    await fs.rm(path.join(directory, 'data.json'));
    const result = await loadArchive(directory);
    assert.equal(result.manifest.archive_id, sourceManifest.archive_id);
    assert.equal(result.docs.orders.size, 1);
    assert.equal(result.files.size, 3);
  });
});

test('archive rejects colliding upload and generated print filenames', async () => {
  await withArchive(async (directory) => {
    const combined = {
      ...manifest(fixtureTables()),
      data: fixtureTables(),
    };
    combined.data.orders[0].print_file_name = combined.data.uploads[0].stored_name;
    await fs.writeFile(path.join(directory, 'archive.json'), JSON.stringify(combined));
    await assert.rejects(loadArchive(directory), /Stored filename .* is shared by/);
  });
});

test('archive refuses an active lease so the old agent cannot double print across cutover', () => {
  const tables = fixtureTables();
  tables.print_jobs[0].status = 'claimed';
  assert.throws(() => toImportModel(tables), /stop the old agent/);
  const printingOrder = fixtureTables();
  printingOrder.orders[0].order_status = 'printing';
  assert.throws(() => toImportModel(printingOrder), /Order order-uuid is printing/);
});

test('archive rejects duplicate identifiers and cross-shop or dangling relationships', () => {
  const duplicateShop = fixtureTables();
  duplicateShop.shops.push({ ...duplicateShop.shops[0], id: 'second-shop-id' });
  assert.throws(() => toImportModel(duplicateShop), /Duplicate shops.public_id/);

  const mismatchedPayment = fixtureTables();
  mismatchedPayment.payments.push({ id: 'payment-id', order_id: ids.order, shop_id: 'another-shop', status: 'verified', amount: '4.00', created_at: '2026-10-01T00:01:00Z' });
  assert.throws(() => toImportModel(mismatchedPayment), /shop that does not match its order/);

  const danglingEvent = fixtureTables();
  danglingEvent.payment_events.push({ id: 'event-id', provider: 'webhook', event_id: 'evt-1', order_id: 'missing-order', order_code: null, payload: {}, created_at: '2026-10-01T00:01:00Z' });
  assert.throws(() => toImportModel(danglingEvent), /Payment event references a missing order/);
});

test('Firebase archive apply is resumable, create-only, and bound to one archive and project', async () => {
  await withArchive(async (directory) => {
    const firebase = fakeFirebase();
    const provider = () => firebase;
    const storageProvider = () => ({
      async get(name) {
        if (!firebase.objects.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return Buffer.from(firebase.objects.get(name));
      },
      async put(name, bytes) { firebase.objects.set(name, Buffer.from(bytes)); },
    });
    const first = await importArchive(directory, { apply: true, firebaseProvider: provider, storageProvider });
    assert.equal(first.alreadyImported, false);
    assert.equal(firebase.collections.get('orders').has(ids.order), true);
    assert.equal(firebase.collections.get('print_jobs').has(ids.order), true);
    assert.equal(firebase.objects.size, 3);
    const retry = await importArchive(directory, { apply: true, firebaseProvider: provider, storageProvider });
    assert.equal(retry.alreadyImported, true);

    const dataPath = path.join(directory, 'data.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    data.shops[0].name = 'A different source snapshot';
    await fs.writeFile(dataPath, JSON.stringify(data));
    await assert.rejects(importArchive(directory, { apply: true, firebaseProvider: provider, storageProvider }), /different archive or Firebase project/);
    assert.equal(firebase.collections.get('shops').get(ids.shop).name, 'Test Print');
  });
});
