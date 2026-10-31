const crypto = require('node:crypto');
const { getFirebase } = require('./firebase');

const COLLECTIONS = Object.freeze({
  shops: 'shops',
  uploads: 'uploads',
  orders: 'orders',
  payments: 'payments',
  printJobs: 'print_jobs',
  orderUploads: 'order_uploads',
  accessExtensions: 'access_extensions',
  auditLog: 'audit_log',
  paymentEvents: 'payment_events',
  uploadOrderClaims: 'upload_order_claims',
  orderCodes: 'order_codes',
  indexes: '_indexes',
  counters: '_counters',
  queueCounters: 'queue_counters',
});

function getDb() {
  return getFirebase().db;
}

function newId() {
  return crypto.randomUUID();
}

function snapshotData(snapshot) {
  if (!snapshot?.exists) return null;
  return { id: snapshot.id, ...snapshot.data() };
}

async function getDoc(collectionName, id) {
  return snapshotData(await getDb().collection(collectionName).doc(String(id)).get());
}

async function findOne(collectionName, field, value) {
  const snapshot = await getDb().collection(collectionName).where(field, '==', value).limit(1).get();
  return snapshot.empty ? null : snapshotData(snapshot.docs[0]);
}

async function listDocs(collectionName, { filters = [], orderBy, limit } = {}) {
  let query = getDb().collection(collectionName);
  for (const [field, operator, value] of filters) query = query.where(field, operator, value);
  if (orderBy) query = query.orderBy(orderBy[0], orderBy[1] || 'asc');
  if (Number.isInteger(limit) && limit > 0) query = query.limit(limit);
  const snapshot = await query.get();
  return snapshot.docs.map(snapshotData);
}

async function insertDoc(collectionName, data, id = newId()) {
  const ref = getDb().collection(collectionName).doc(String(id));
  await ref.create({ ...data, created_at: data.created_at || new Date().toISOString() });
  return { id: ref.id, ...data };
}

async function updateDoc(collectionName, id, patch) {
  const ref = getDb().collection(collectionName).doc(String(id));
  await ref.update({ ...patch, updated_at: new Date().toISOString() });
  return snapshotData(await ref.get());
}

async function deleteDoc(collectionName, id) {
  await getDb().collection(collectionName).doc(String(id)).delete();
}

async function writeAudit({ shop_id = null, actor, action, details = {} }) {
  return insertDoc(COLLECTIONS.auditLog, { shop_id, actor, action, details });
}

module.exports = {
  COLLECTIONS,
  deleteDoc,
  findOne,
  getDb,
  getDoc,
  insertDoc,
  listDocs,
  newId,
  snapshotData,
  updateDoc,
  writeAudit,
};
