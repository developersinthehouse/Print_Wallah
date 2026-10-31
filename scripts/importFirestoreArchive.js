#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getFirebase } = require('../src/firebase');
const { fileStorage } = require('../src/services/fileStorage');
const { isSafeStoredFilename } = require('../src/services/storagePolicy');

const BATCH_SIZE = 400;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 900 * 1024;
const RUNS = 'migration_runs';
const IMPORTED_COLLECTIONS = [
  'shops', 'uploads', 'orders', 'payments', 'print_jobs', 'order_uploads',
  'access_extensions', 'audit_log', 'payment_events', 'upload_order_claims',
  'order_codes', 'queue_counters',
];
const REQUIRED_TABLES = [
  'shops', 'uploads', 'orders', 'payments', 'print_jobs', 'order_uploads',
  'access_extensions', 'audit_log', 'payment_events',
];
const JSON_FIELDS = new Set(['pricing', 'print_config', 'config', 'details', 'payload']);
const DATE_FIELDS = new Set([
  'access_start', 'access_end', 'agent_last_seen', 'created_at', 'updated_at',
  'expires_at', 'payment_claimed_at', 'confirmed_at', 'completed_at',
  'files_deleted_at', 'claimed_at', 'previous_expiry', 'new_expiry',
]);
const NUMBER_FIELDS = new Set([
  'amount', 'byte_size', 'page_count', 'copies', 'queue_position', 'attempts',
  'quantity', 'position', 'days',
]);

function fail(message) { throw new Error(message); }

function parseDate(value, field) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`Invalid timestamp in ${field}`);
  return date.toISOString();
}

function normalizeRow(row, collection) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Invalid row in ${collection}`);
  const { id: ignoredId, ...data } = row;
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) { delete data[field]; continue; }
    if (JSON_FIELDS.has(field) && typeof value === 'string') {
      try { data[field] = JSON.parse(value); }
      catch { fail(`Invalid JSON in ${collection}.${field}`); }
    } else if (DATE_FIELDS.has(field)) {
      data[field] = parseDate(value, `${collection}.${field}`);
    } else if (NUMBER_FIELDS.has(field) && value != null) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) fail(`Invalid number in ${collection}.${field}`);
      data[field] = numeric;
    }
  }
  return data;
}

function addDoc(target, id, data, label) {
  const key = String(id ?? '');
  if (!key || key.includes('/') || key === '.' || key === '..') fail(`Invalid document id in ${label}`);
  if (target.has(key)) fail(`Duplicate document id ${key} in ${label}`);
  target.set(key, data);
}

function assertUnique(rows, table, field) {
  const seen = new Set();
  for (const row of rows) {
    const value = row?.[field];
    if (typeof value !== 'string' || !value.trim()) fail(`${table}.${field} must be a non-empty string`);
    if (seen.has(value)) fail(`Duplicate ${table}.${field}: ${value}`);
    seen.add(value);
  }
}

function toImportModel(tables) {
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) fail('Archive data must be an object of table arrays');
  for (const name of REQUIRED_TABLES) if (!Array.isArray(tables[name])) fail(`Archive is missing the ${name} array`);
  const docs = Object.fromEntries(IMPORTED_COLLECTIONS.map((name) => [name, new Map()]));
  const rows = Object.fromEntries(REQUIRED_TABLES.map((name) => [name, tables[name]]));
  for (const field of ['public_id', 'admin_email']) assertUnique(rows.shops, 'shops', field);
  for (const field of ['public_token', 'stored_name']) assertUnique(rows.uploads, 'uploads', field);
  const shops = new Map(rows.shops.map((row) => [String(row.id), row]));
  const uploads = new Map(rows.uploads.map((row) => [String(row.id), row]));
  const orders = new Map(rows.orders.map((row) => [String(row.id), row]));
  const itemsByOrder = new Map();

  for (const row of rows.order_uploads) {
    const orderId = String(row.order_id);
    const uploadId = String(row.upload_id);
    if (!orders.has(orderId) || !uploads.has(uploadId)) fail(`order_uploads references a missing order or upload (${orderId}, ${uploadId})`);
    const items = itemsByOrder.get(orderId) || [];
    const quantity = Number(row.quantity);
    const position = Number(row.position || 0);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500 || !Number.isInteger(position) || position < 0) {
      fail(`Invalid quantity or position in order_uploads for order ${orderId}`);
    }
    if (items.some((item) => item.upload_id === uploadId)) fail(`Duplicate order/upload pair in order_uploads (${orderId}, ${uploadId})`);
    items.push({ upload_id: uploadId, quantity, position });
    itemsByOrder.set(orderId, items);
    const joinId = `${orderId}_${uploadId}`;
    addDoc(docs.order_uploads, joinId, normalizeRow(row, 'order_uploads'), 'order_uploads');
  }

  for (const row of rows.shops) addDoc(docs.shops, row.id, normalizeRow(row, 'shops'), 'shops');
  for (const row of rows.uploads) {
    if (!shops.has(String(row.shop_id))) fail(`Upload ${row.id} references a missing shop`);
    addDoc(docs.uploads, row.id, normalizeRow(row, 'uploads'), 'uploads');
  }
  for (const row of rows.orders) {
    if (row.order_status === 'printing') fail(`Order ${row.id} is printing; stop the old print agent and export after it finishes`);
    if (!shops.has(String(row.shop_id)) || !uploads.has(String(row.upload_id))) fail(`Order ${row.id} references a missing shop or primary upload`);
    const data = normalizeRow(row, 'orders');
    let items = itemsByOrder.get(String(row.id)) || [];
    if (!items.some((item) => item.upload_id === String(row.upload_id))) {
      items = [{ upload_id: String(row.upload_id), quantity: Number(row.config?.photoQuantity || 1), position: 0 }, ...items];
    }
    items.sort((a, b) => a.position - b.position);
    data.items = items;
    data.upload_ids = [...new Set(items.map((item) => item.upload_id))];
    addDoc(docs.orders, row.id, data, 'orders');
    addDoc(docs.order_codes, row.order_code, { order_id: String(row.id), created_at: data.created_at }, 'order_codes');
    for (const uploadId of data.upload_ids) {
      const upload = uploads.get(uploadId);
      if (String(upload.shop_id) !== String(row.shop_id)) fail(`Order ${row.id} contains an upload from another shop`);
      addDoc(docs.upload_order_claims, uploadId, { order_id: String(row.id), shop_id: String(row.shop_id), created_at: data.created_at }, 'upload_order_claims');
    }
  }

  for (const row of rows.payments) {
    if (!orders.has(String(row.order_id))) fail(`Payment references a missing order (${row.order_id})`);
    if (String(row.shop_id) !== String(orders.get(String(row.order_id)).shop_id)) fail(`Payment for order ${row.order_id} has a shop that does not match its order`);
    const data = normalizeRow(row, 'payments');
    addDoc(docs.payments, row.order_id, data, 'payments');
  }
  const queueMax = new Map();
  for (const row of rows.print_jobs) {
    if (!orders.has(String(row.order_id))) fail(`Print job references a missing order (${row.order_id})`);
    if (['claimed', 'printing'].includes(row.status)) fail(`Print job ${row.id} is ${row.status}; stop the old agent and export again after the queue is idle`);
    const data = normalizeRow(row, 'print_jobs');
    const order = orders.get(String(row.order_id));
    if (String(order.shop_id) !== String(row.shop_id)) fail(`Print job ${row.id} has a shop that does not match its order`);
    addDoc(docs.print_jobs, row.order_id, data, 'print_jobs');
    const position = Number(data.queue_position || 0);
    const shopId = String(row.shop_id);
    const current = queueMax.get(shopId) || { value: 0, updated_at: null };
    queueMax.set(shopId, {
      value: Math.max(current.value, position),
      updated_at: !current.updated_at || data.updated_at > current.updated_at ? data.updated_at : current.updated_at,
    });
  }
  for (const [shopId, counter] of queueMax) addDoc(docs.queue_counters, shopId, counter, 'queue_counters');

  for (const row of rows.access_extensions) {
    if (!shops.has(String(row.shop_id))) fail(`Access extension ${row.id} references a missing shop`);
    addDoc(docs.access_extensions, row.id, normalizeRow(row, 'access_extensions'), 'access_extensions');
  }
  for (const row of rows.audit_log) {
    if (row.shop_id != null && !shops.has(String(row.shop_id))) fail(`Audit entry ${row.id} references a missing shop`);
    addDoc(docs.audit_log, row.id, normalizeRow(row, 'audit_log'), 'audit_log');
  }
  for (const row of rows.payment_events) {
    if (typeof row.provider !== 'string' || !row.provider || typeof row.event_id !== 'string' || !row.event_id) fail('Payment events must include provider and event_id');
    if (row.order_id != null && !orders.has(String(row.order_id))) fail(`Payment event references a missing order (${row.order_id})`);
    if (row.order_id != null && row.order_code && String(orders.get(String(row.order_id)).order_code) !== String(row.order_code)) fail(`Payment event for order ${row.order_id} has a mismatched order code`);
    const id = crypto.createHash('sha256').update(`${row.provider}:${row.event_id}`).digest('hex');
    addDoc(docs.payment_events, id, normalizeRow(row, 'payment_events'), 'payment_events');
  }
  return docs;
}

async function loadArchive(directory, { now = new Date() } = {}) {
  const combinedPath = path.join(directory, 'archive.json');
  const manifestPath = path.join(directory, 'manifest.json');
  const dataPath = path.join(directory, 'data.json');
  let manifest;
  let tables;
  let archiveBytes;
  try {
    archiveBytes = await fs.readFile(combinedPath);
    const archive = JSON.parse(archiveBytes.toString('utf8'));
    manifest = archive;
    tables = archive.data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const [manifestBytes, dataBytes] = await Promise.all([fs.readFile(manifestPath), fs.readFile(dataPath)]);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    tables = JSON.parse(dataBytes.toString('utf8'));
    archiveBytes = Buffer.concat([manifestBytes, dataBytes]);
  }
  if (manifest.version !== 1 || !/^[a-zA-Z0-9_-]{8,100}$/.test(String(manifest.archive_id || ''))) fail('Archive manifest must have version 1 and an 8–100 character archive_id');
  if (!manifest.counts || typeof manifest.counts !== 'object') fail('Archive manifest must include source row counts for every required table');
  for (const table of REQUIRED_TABLES) {
    if (!Number.isInteger(manifest.counts[table]) || manifest.counts[table] < 0 || !Array.isArray(tables[table]) || manifest.counts[table] !== tables[table].length) {
      fail(`Archive row count for ${table} does not match its manifest`);
    }
  }
  const docs = toImportModel(tables);
  const filesDir = path.join(directory, 'files');
  const files = new Map();
  const mimeByName = new Map();
  const fileOwners = new Map();
  const registerFile = (name, contentType, owner) => {
    if (!name) return;
    if (fileOwners.has(name)) fail(`Stored filename ${name} is shared by ${fileOwners.get(name)} and ${owner}`);
    fileOwners.set(name, owner);
    mimeByName.set(name, contentType);
  };
  for (const row of tables.uploads) registerFile(row.stored_name, row.mime_type || 'application/octet-stream', `upload ${row.id}`);
  for (const row of tables.orders) registerFile(row.print_file_name, 'application/pdf', `order ${row.id} print file`);

  const requiredActiveFiles = new Set();
  for (const row of tables.orders) {
    const completedAt = new Date(row.completed_at).getTime();
    const recentCompleted = row.order_status === 'completed' && !row.files_deleted_at && Number.isFinite(completedAt) && completedAt > now.getTime() - 10 * 60 * 1000;
    if (row.order_status === 'cancelled' || row.order_status === 'completed' && !recentCompleted) continue;
    if (row.print_file_name) requiredActiveFiles.add(row.print_file_name);
    else for (const item of docs.orders.get(String(row.id)).upload_ids) {
      const upload = tables.uploads.find((entry) => String(entry.id) === item);
      if (upload?.stored_name) requiredActiveFiles.add(upload.stored_name);
    }
  }

  if (mimeByName.size) {
    try {
      const directoryStat = await fs.lstat(filesDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('Archive files path must be a real directory, not a symbolic link');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (requiredActiveFiles.size) fail('Archive files directory is missing');
    }
  }

  for (const name of mimeByName.keys()) {
    if (!isSafeStoredFilename(name)) fail(`Unsafe stored filename in archive: ${name}`);
    try {
      const filePath = path.join(filesDir, name);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`Archive file is not a regular file: ${name}`);
      const expectedBytes = Number(tables.uploads.find((row) => row.stored_name === name)?.byte_size);
      if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && stat.size !== expectedBytes) fail(`File size mismatch for ${name}`);
      files.set(name, { path: filePath, contentType: mimeByName.get(name), size: stat.size });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (requiredActiveFiles.has(name)) fail(`Active/retryable order file is missing from archive: ${name}`);
    }
  }
  const digest = crypto.createHash('sha256').update(archiveBytes);
  for (const [name, file] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(name);
    for await (const chunk of fsSync.createReadStream(file.path)) digest.update(chunk);
  }
  return { manifest, docs, files, archiveDigest: digest.digest('hex') };
}

async function preflightEmpty(db) {
  for (const name of IMPORTED_COLLECTIONS) {
    const result = await db.collection(name).limit(1).get();
    if (!result.empty) fail(`Destination collection ${name} is not empty. Use a new Firebase project for this import.`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function writeDocumentsSafely(db, collectionName, pairs) {
  const slices = [];
  let slice = [];
  let sliceBytes = 0;
  for (const pair of pairs) {
    const bytes = Buffer.byteLength(stableJson(pair[1]));
    if (bytes > MAX_DOCUMENT_BYTES) fail(`Document ${collectionName}/${pair[0]} is too large for Firestore`);
    if (slice.length && (slice.length >= BATCH_SIZE || sliceBytes + bytes > MAX_BATCH_BYTES)) {
      slices.push(slice);
      slice = [];
      sliceBytes = 0;
    }
    slice.push(pair);
    sliceBytes += bytes;
  }
  if (slice.length) slices.push(slice);
  for (const slice of slices) {
    await db.runTransaction(async (transaction) => {
      const refs = slice.map(([id]) => db.collection(collectionName).doc(id));
      const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
      for (let index = 0; index < snapshots.length; index += 1) {
        if (snapshots[index].exists && stableJson(snapshots[index].data()) !== stableJson(slice[index][1])) {
          fail(`Destination document ${collectionName}/${slice[index][0]} differs from this archive; import stopped without overwriting it`);
        }
      }
      for (let index = 0; index < refs.length; index += 1) {
        if (!snapshots[index].exists) transaction.create(refs[index], slice[index][1]);
      }
    });
  }
}

async function importArchive(directory, { apply = false, now = new Date(), firebaseProvider = getFirebase, storageProvider = () => fileStorage } = {}) {
  const { manifest, docs, files, archiveDigest } = await loadArchive(directory, { now });
  const counts = Object.fromEntries(Object.entries(docs).map(([name, entries]) => [name, entries.size]));
  const summary = { archive_id: manifest.archive_id, archive_sha256: archiveDigest, counts, files: files.size, bytes: [...files.values()].reduce((sum, file) => sum + file.size, 0) };
  if (!apply) return { dryRun: true, summary };

  const { db, projectId } = firebaseProvider();
  const storage = storageProvider();
  const runRef = db.collection(RUNS).doc(manifest.archive_id);
  const priorRun = await runRef.get();
  if (priorRun.exists) {
    const run = priorRun.data();
    if (run.archive_sha256 !== archiveDigest || run.target_project_id !== projectId) fail(`Migration run ${manifest.archive_id} already belongs to a different archive or Firebase project`);
    if (run.status === 'complete') return { dryRun: false, alreadyImported: true, summary: run.summary };
    if (run.status !== 'running') fail(`Migration run ${manifest.archive_id} is marked ${run.status}`);
  } else {
    await preflightEmpty(db);
    await runRef.create({ archive_id: manifest.archive_id, archive_sha256: archiveDigest, source: 'production-postgresql-archive', target_project_id: projectId, status: 'running', started_at: new Date().toISOString(), summary });
  }

  for (const [name, file] of files) {
    const bytes = await fs.readFile(file.path);
    try {
      const stored = await storage.get(name);
      if (!stored.equals(bytes)) fail(`Storage object ${name} already exists with different bytes; import stopped without overwriting it`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await storage.put(name, bytes, file.contentType);
    }
  }

  for (const [collectionName, entries] of Object.entries(docs)) {
    await writeDocumentsSafely(db, collectionName, [...entries.entries()]);
  }

  await runRef.update({ status: 'complete', completed_at: new Date().toISOString(), summary });
  return { dryRun: false, alreadyImported: false, summary };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((arg) => arg !== '--apply' && arg !== '--dry-run');
  if (positional.length !== 1) fail('Usage: node scripts/importFirestoreArchive.js <private-archive-folder> [--dry-run|--apply]');
  const result = await importArchive(path.resolve(positional[0]), { apply });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.log('Dry run only. Review the counts and missing-file checks before repeating with --apply.');
}

if (require.main === module) main().catch((error) => { console.error(`Import failed: ${error.message}`); process.exitCode = 1; });

module.exports = { BATCH_SIZE, MAX_BATCH_BYTES, MAX_DOCUMENT_BYTES, loadArchive, normalizeRow, toImportModel, importArchive };
