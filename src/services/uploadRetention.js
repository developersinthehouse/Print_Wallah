const { COLLECTIONS, getDb } = require('../firestoreStore');
const { fileStorage } = require('./fileStorage');
const { isSafeStoredFilename } = require('./storagePolicy');

const CLEANUP_BATCH_SIZE = 100;

async function cleanupExpiredUploads({ db = getDb(), storage = fileStorage, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const candidates = await db.collection(COLLECTIONS.uploads)
    .where('expires_at', '<=', nowIso)
    .orderBy('expires_at', 'asc')
    .limit(CLEANUP_BATCH_SIZE)
    .get();
  let removed = 0;

  for (const candidate of candidates.docs) {
    const storedName = await db.runTransaction(async (transaction) => {
      const [upload, claim] = await Promise.all([
        transaction.get(candidate.ref),
        transaction.get(db.collection(COLLECTIONS.uploadOrderClaims).doc(candidate.id)),
      ]);
      if (!upload.exists || claim.exists) return null;
      const data = upload.data();
      if (new Date(data.expires_at).getTime() > now.getTime()) return null;
      if (!data.cleanup_pending) transaction.update(candidate.ref, { cleanup_pending: true, cleanup_started_at: nowIso, updated_at: nowIso });
      return data.stored_name || null;
    });
    if (storedName === null) continue;

    if (!isSafeStoredFilename(storedName)) {
      console.warn(`Skipped expired upload ${candidate.id} with an unsafe stored filename`);
      continue;
    }
    // Keep metadata marked for cleanup until Storage confirms deletion. If the
    // request fails, the next scheduled pass retries the idempotent delete.
    await storage.delete(storedName);
    const deleted = await db.runTransaction(async (transaction) => {
      const [upload, claim] = await Promise.all([
        transaction.get(candidate.ref),
        transaction.get(db.collection(COLLECTIONS.uploadOrderClaims).doc(candidate.id)),
      ]);
      if (!upload.exists || claim.exists || !upload.data().cleanup_pending) return false;
      if (new Date(upload.data().expires_at).getTime() > now.getTime()) return false;
      transaction.delete(candidate.ref);
      return true;
    });
    if (deleted) removed += 1;
  }
  return { uploadsDeleted: removed };
}

module.exports = { cleanupExpiredUploads };
