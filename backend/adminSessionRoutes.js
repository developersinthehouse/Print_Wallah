const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const MAX_TRACKED_ADDRESSES = 10000;
const DUMMY_PASSWORD_SALT = Buffer.alloc(16, 0x5a);
const DUMMY_PASSWORD_HASH = crypto.scryptSync(
  'invalid-admin-account-password',
  DUMMY_PASSWORD_SALT,
  64,
  { N: 16384, r: 8, p: 1 },
);
const DUMMY_PASSWORD_HASH_ENCODED = `scrypt$${DUMMY_PASSWORD_SALT.toString('base64url')}$${DUMMY_PASSWORD_HASH.toString('base64url')}`;

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) return reject(error);
      return resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new RangeError('Super-admin password must be between 12 and 1024 characters');
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = await derivePassword(password, salt);
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const [algorithm, saltValue, hashValue, ...extra] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue || extra.length > 0) return false;

  let salt;
  let expectedHash;
  try {
    salt = Buffer.from(saltValue, 'base64url');
    expectedHash = Buffer.from(hashValue, 'base64url');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expectedHash.length !== 64) return false;

  const actualHash = await derivePassword(password, salt);
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function createSuperAdminSessionRouter({ pool, jwtSecret, issuer, audience, now = () => new Date() }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL pool is required for admin login');
  }
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32 || !issuer || !audience) {
    throw new TypeError('A strong super-admin JWT secret, issuer, and audience are required');
  }

  const loginAttempts = new Map();
  const router = express.Router();

  router.post('/login', express.json({ limit: '8kb' }), async (request, response, next) => {
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    const currentTime = now().getTime();
    const currentAttempts = loginAttempts.get(address);
    if (currentAttempts && currentTime - currentAttempts.startedAt < LOGIN_WINDOW_MS && currentAttempts.count >= LOGIN_ATTEMPT_LIMIT) {
      return response.status(429).json({ error: 'ADMIN_LOGIN_RATE_LIMITED' });
    }

    if (loginAttempts.size > MAX_TRACKED_ADDRESSES) {
      for (const [trackedAddress, attempt] of loginAttempts) {
        if (currentTime - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(trackedAddress);
      }
    }

    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = request.body?.password;
    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' ||
      password.length < 1 ||
      password.length > 1024
    ) {
      return response.status(400).json({ error: 'INVALID_ADMIN_CREDENTIALS' });
    }

    try {
      const result = await pool.query(
        'SELECT id, email, password_hash FROM super_admin_users WHERE email = $1',
        [email],
      );
      const admin = result.rows[0];
      const passwordMatches = await verifyPassword(password, admin?.password_hash || DUMMY_PASSWORD_HASH_ENCODED);
      if (!admin || !passwordMatches) {
        const previous = loginAttempts.get(address);
        if (previous && currentTime - previous.startedAt < LOGIN_WINDOW_MS) {
          previous.count += 1;
        } else {
          loginAttempts.set(address, { startedAt: currentTime, count: 1 });
        }
        return response.status(401).json({ error: 'INVALID_ADMIN_CREDENTIALS' });
      }

      loginAttempts.delete(address);
      const loggedInAt = now();
      await pool.query('UPDATE super_admin_users SET last_login_at = $2 WHERE id = $1', [admin.id, loggedInAt]);
      const accessToken = jwt.sign({ role: 'SUPER_ADMIN' }, jwtSecret, {
        subject: admin.id,
        issuer,
        audience,
        expiresIn: '15m',
        algorithm: 'HS256',
      });
      return response.json({ accessToken, tokenType: 'Bearer', expiresIn: 900, email: admin.email });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSuperAdminSessionRouter, hashPassword, verifyPassword };