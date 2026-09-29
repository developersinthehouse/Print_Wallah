const { Pool } = require('pg');

function createPool({
  connectionString = process.env.DATABASE_URL,
  ssl = process.env.DATABASE_SSL === 'require',
} = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to connect to PostgreSQL');
  }

  return new Pool({
    connectionString,
    ssl: ssl || undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    application_name: 'print-wallah-backend',
  });
}

module.exports = { createPool };