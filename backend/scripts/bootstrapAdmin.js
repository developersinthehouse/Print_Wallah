const crypto = require('node:crypto');
const { loadConfiguration } = require('../config');
const { createPool } = require('../db/pool');
const { hashPassword } = require('../adminSessionRoutes');

async function bootstrapAdmin(environment = process.env, { poolFactory = createPool, logger = console } = {}) {
  const email = typeof environment.SUPER_ADMIN_EMAIL === 'string'
    ? environment.SUPER_ADMIN_EMAIL.trim().toLowerCase()
    : '';
  const password = environment.SUPER_ADMIN_PASSWORD;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set SUPER_ADMIN_EMAIL to the initial admin email in backend/.env');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Set SUPER_ADMIN_PASSWORD to a unique password of at least 12 characters');
  }

  const configuration = loadConfiguration(environment);
  const pool = poolFactory({
    connectionString: configuration.databaseUrl,
    ssl: configuration.databaseSsl,
  });
  try {
    const existingAdmin = await pool.query(
      'SELECT id FROM super_admin_users WHERE email = $1',
      [email],
    );
    if (existingAdmin.rowCount > 0) {
      throw new Error('A super-admin account with this email already exists; bootstrap does not overwrite passwords');
    }

    const result = await pool.query(
      `INSERT INTO super_admin_users (id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`admin_${crypto.randomUUID()}`, email, await hashPassword(password)],
    );
    if (result.rowCount !== 1) {
      throw new Error('A super-admin account with this email already exists; bootstrap does not overwrite passwords');
    }
    logger.info(`Super-admin account is ready for ${email}. Remove SUPER_ADMIN_PASSWORD from backend/.env after bootstrap.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
  bootstrapAdmin().catch((error) => {
    console.error('Super-admin bootstrap failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { bootstrapAdmin };