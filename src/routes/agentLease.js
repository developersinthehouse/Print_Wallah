const crypto = require('node:crypto');
const express = require('express');

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createAgentLeaseRouter(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A database pool is required for agent lease renewal');
  }

  const router = express.Router({ mergeParams: true });

  router.post('/jobs/:jobId/heartbeat', async (request, response, next) => {
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
    if (!tokenMatch) return response.status(401).json({ error: 'Invalid print-agent token' });

    try {
      const shopResult = await pool.query(
        'SELECT id FROM shops WHERE public_id = $1 AND agent_token_hash = $2',
        [request.params.shopId, hashToken(tokenMatch[1])],
      );
      const shop = shopResult.rows[0];
      if (!shop) return response.status(401).json({ error: 'Invalid print-agent token' });

      const leaseResult = await pool.query(
        `UPDATE print_jobs
         SET claimed_at = NOW()
         WHERE id = $1 AND shop_id = $2 AND claimed_by = 'print-agent' AND status = 'claimed'
         RETURNING id`,
        [request.params.jobId, shop.id],
      );
      if (!leaseResult.rows[0]) return response.status(409).json({ error: 'Job lease is no longer active' });

      await pool.query('UPDATE shops SET agent_last_seen = NOW() WHERE id = $1', [shop.id]);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createAgentLeaseRouter };