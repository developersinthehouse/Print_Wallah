const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const databaseSsl = String(process.env.DATABASE_SSL || '').toLowerCase();
const ssl = databaseSsl === 'true'
  ? { rejectUnauthorized: false }
  : databaseSsl === 'strict'
    ? { rejectUnauthorized: true }
    : undefined;
const requestedPoolSize = Number(process.env.DB_POOL_MAX || 10);
if (!Number.isInteger(requestedPoolSize) || requestedPoolSize < 1 || requestedPoolSize > 100) {
  throw new Error('DB_POOL_MAX must be an integer between 1 and 100');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: requestedPoolSize,
  idleTimeoutMillis: 30000,
});
pool.on('error', (error) => console.error('Unexpected database pool error', error.message));

async function initialize() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
}
module.exports = { pool, initialize };
