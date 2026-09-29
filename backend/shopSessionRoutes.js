const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword } = require('./adminSessionRoutes');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const MAX_TRACKED_ADDRESSES = 10000;
const DUMMY_PASSWORD_SALT = Buffer.alloc(16, 0x6b);
const DUMMY_PASSWORD_HASH = crypto.scryptSync(
  'invalid-shop-account-password',
  DUMMY_PASSWORD_SALT,
  64,
  { N: 16384, r: 8, p: 1 },
);
const DUMMY_PASSWORD_HASH_ENCODED = `scrypt$${DUMMY_PASSWORD_SALT.toString('base64url')}$${DUMMY_PASSWORD_HASH.toString('base64url')}`;

function createShopSessionRouter({ pool, jwtSecret, issuer, audience, now = () => new Date() }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required for shop login');
  }
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32 || !issuer || !audience) {
    throw new TypeError('A strong shop JWT secret, issuer, and audience are required');
  }

  const loginAttempts = new Map();
  const router = express.Router();

  function isRateLimited(request, response, key) {
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    const currentTime = now().getTime();
    const attemptKey = `${key}:${address}`;
    const currentAttempts = loginAttempts.get(attemptKey);
    if (currentAttempts && currentTime - currentAttempts.startedAt < LOGIN_WINDOW_MS && currentAttempts.count >= LOGIN_ATTEMPT_LIMIT) {
      response.status(429).json({ error: 'SHOP_LOGIN_RATE_LIMITED' });
      return true;
    }
    if (loginAttempts.size > MAX_TRACKED_ADDRESSES) {
      for (const [trackedAddress, attempt] of loginAttempts) {
        if (currentTime - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(trackedAddress);
      }
    }
    return false;
  }

  function recordFailure(request, key) {
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    const attemptKey = `${key}:${address}`;
    const currentTime = now().getTime();
    const previous = loginAttempts.get(attemptKey);
    if (previous && currentTime - previous.startedAt < LOGIN_WINDOW_MS) {
      previous.count += 1;
    } else {
      loginAttempts.set(attemptKey, { startedAt: currentTime, count: 1 });
    }
  }

  function issueToken(shopId) {
    const accessToken = jwt.sign({ role: 'SHOP_ADMIN', shopId }, jwtSecret, {
      subject: shopId,
      issuer,
      audience,
      expiresIn: '8h',
      algorithm: 'HS256',
    });
    return { accessToken, tokenType: 'Bearer', expiresIn: 28800, shopId };
  }

  router.post('/setup', express.json({ limit: '8kb' }), async (request, response, next) => {
    if (isRateLimited(request, response, 'setup')) return;
    const shopId = typeof request.body?.shopId === 'string' ? request.body.shopId.trim() : '';
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const setupToken = request.body?.setupToken;
    const password = request.body?.password;
    if (
      !shopId || shopId.length > 100 ||
      email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof setupToken !== 'string' || setupToken.length < 32 || setupToken.length > 200 ||
      typeof password !== 'string' || password.length < 12 || password.length > 1024
    ) {
      recordFailure(request, 'setup');
      return response.status(400).json({ error: 'INVALID_SHOP_SETUP' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const credentialResult = await client.query(
        `SELECT credentials.setup_token_hash, credentials.setup_expires_at
         FROM shop_admin_credentials AS credentials
         JOIN shop_profiles AS shop ON shop.id = credentials.shop_id
         WHERE credentials.shop_id = $1 AND shop.owner_email = $2
         FOR UPDATE`,
        [shopId, email],
      );
      const credential = credentialResult.rows[0];
      const submittedHash = crypto.createHash('sha256').update(setupToken).digest();
      const storedHash = credential?.setup_token_hash
        ? Buffer.from(credential.setup_token_hash, 'hex')
        : Buffer.alloc(32);
      const tokenMatches = storedHash.length === submittedHash.length && crypto.timingSafeEqual(storedHash, submittedHash);
      if (
        !credential || !credential.setup_token_hash || !tokenMatches ||
        !credential.setup_expires_at || new Date(credential.setup_expires_at) <= now()
      ) {
        await client.query('ROLLBACK');
        recordFailure(request, 'setup');
        return response.status(400).json({ error: 'INVALID_SHOP_SETUP' });
      }

      const passwordHash = await hashPassword(password);
      await client.query(
        `UPDATE shop_admin_credentials
         SET password_hash = $2, setup_token_hash = NULL, setup_expires_at = NULL, updated_at = $3
         WHERE shop_id = $1`,
        [shopId, passwordHash, now()],
      );
      await client.query('COMMIT');
      loginAttempts.delete(`setup:${request.ip || request.socket.remoteAddress || 'unknown'}`);
      return response.json(issueToken(shopId));
    } catch (error) {
      await client.query('ROLLBACK');
      return next(error);
    } finally {
      client.release();
    }
  });

  router.post('/login', express.json({ limit: '8kb' }), async (request, response, next) => {
    if (isRateLimited(request, response, 'login')) return;
    const shopId = typeof request.body?.shopId === 'string' ? request.body.shopId.trim() : '';
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = request.body?.password;
    if (
      !shopId || shopId.length > 100 || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 1 || password.length > 1024
    ) {
      recordFailure(request, 'login');
      return response.status(400).json({ error: 'INVALID_SHOP_CREDENTIALS' });
    }

    try {
      const result = await pool.query(
        `SELECT credentials.password_hash
         FROM shop_admin_credentials AS credentials
         JOIN shop_profiles AS shop ON shop.id = credentials.shop_id
         WHERE credentials.shop_id = $1 AND shop.owner_email = $2`,
        [shopId, email],
      );
      const passwordHash = result.rows[0]?.password_hash || DUMMY_PASSWORD_HASH_ENCODED;
      const passwordMatches = await verifyPassword(password, passwordHash);
      if (!result.rows[0]?.password_hash || !passwordMatches) {
        recordFailure(request, 'login');
        return response.status(401).json({ error: 'INVALID_SHOP_CREDENTIALS' });
      }

      loginAttempts.delete(`login:${request.ip || request.socket.remoteAddress || 'unknown'}`);
      return response.json(issueToken(shopId));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createShopSessionRouter };