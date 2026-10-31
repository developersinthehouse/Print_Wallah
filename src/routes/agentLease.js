const crypto = require('node:crypto');
const express = require('express');
const { COLLECTIONS, getDb } = require('../firestoreStore');

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createAgentLeaseRouter({ db: suppliedDb } = {}) {
  const router = express.Router({ mergeParams: true });
  router.post('/jobs/:jobId/heartbeat', async (request, response, next) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.jobId)) {
      return response.status(400).json({ error: 'Invalid print job id' });
    }
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
    if (!tokenMatch) return response.status(401).json({ error: 'Invalid print-agent token' });
    try {
      const db = suppliedDb || getDb();
      const shopSnapshot = await db.collection(COLLECTIONS.shops)
        .where('public_id', '==', request.params.shopId)
        .where('agent_token_hash', '==', hashToken(tokenMatch[1]))
        .limit(1).get();
      if (shopSnapshot.empty) return response.status(401).json({ error: 'Invalid print-agent token' });
      const shopRef = shopSnapshot.docs[0].ref;
      const jobRef = db.collection(COLLECTIONS.printJobs).doc(String(request.params.jobId));
      const now = new Date().toISOString();
      const renewed = await db.runTransaction(async (transaction) => {
        const [jobSnapshot, currentShop] = await Promise.all([transaction.get(jobRef), transaction.get(shopRef)]);
        if (!jobSnapshot.exists || !currentShop.exists) return false;
        const job = jobSnapshot.data();
        if (job.shop_id !== shopRef.id || job.claimed_by !== 'print-agent' || job.status !== 'claimed') return false;
        transaction.update(jobRef, { claimed_at: now, updated_at: now });
        transaction.update(shopRef, { agent_last_seen: now, updated_at: now });
        return true;
      });
      if (!renewed) return response.status(409).json({ error: 'Job lease is no longer active' });
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = { createAgentLeaseRouter };
