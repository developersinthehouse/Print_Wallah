const { COLLECTIONS, getDb } = require('../firestoreStore');
const { fileStorage } = require('./fileStorage');
const { isSafeStoredFilename } = require('./storagePolicy');

const PRINT_FILE_RETENTION_MS = 10 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

async function cleanupCompletedOrderFiles({ db = getDb(), storage = fileStorage, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - PRINT_FILE_RETENTION_MS).toISOString();
  const snapshot = await db.collection(COLLECTIONS.orders)
    .where('order_status', '==', 'completed')
    .where('files_deleted_at', '==', null)
    .where('completed_at', '<=', cutoff)
    .orderBy('completed_at', 'asc')
    .limit(CLEANUP_BATCH_SIZE)
    .get();

  let deletedFiles = 0;
  for (const orderSnapshot of snapshot.docs) {
    const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
    const uploads = new Set([order.upload_id, ...(Array.isArray(order.upload_ids) ? order.upload_ids : [])].filter(Boolean));
    if (Array.isArray(order.items)) for (const item of order.items) if (item.upload_id) uploads.add(item.upload_id);
    const storedNames = new Set();
    for (const uploadId of uploads) {
      const upload = await db.collection(COLLECTIONS.uploads).doc(String(uploadId)).get();
      if (upload.exists && upload.data().stored_name) storedNames.add(upload.data().stored_name);
    }
    if (order.print_file_name) storedNames.add(order.print_file_name);

    let skippedUnsafeFiles = 0;
    for (const storedName of storedNames) {
      if (!isSafeStoredFilename(storedName)) {
        skippedUnsafeFiles += 1;
        continue;
      }
      await storage.delete(storedName);
      deletedFiles += 1;
    }
    if (skippedUnsafeFiles) console.warn(`Skipped ${skippedUnsafeFiles} unsafe stored filename(s) for completed order ${order.id}`);
    await orderSnapshot.ref.update({ files_deleted_at: now.toISOString(), updated_at: now.toISOString() });
  }
  return { ordersDeleted: snapshot.size, filesDeleted: deletedFiles };
}

module.exports = { cleanupCompletedOrderFiles, PRINT_FILE_RETENTION_MS };
