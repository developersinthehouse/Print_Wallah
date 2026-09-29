const fs = require('node:fs/promises');
const path = require('node:path');

async function runMigrations(pool, migrationsDirectory = path.join(__dirname, 'migrations')) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);

  const migrationFiles = (await fs.readdir(migrationsDirectory))
    .filter((fileName) => /^\d+.*\.sql$/.test(fileName))
    .sort();

  for (const fileName of migrationFiles) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT name FROM schema_migrations WHERE name = $1',
        [fileName],
      );
      if (existing.rowCount === 0) {
        const migrationSql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)',
          [fileName, new Date()],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return migrationFiles.length;
}

async function main() {
  require('dotenv').config();
  const { createPool } = require('./pool');
  const pool = createPool();
  try {
    const count = await runMigrations(pool);
    console.info(`Database migrations checked (${count} file(s))`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Database migration failed', error);
    process.exitCode = 1;
  });
}

module.exports = { runMigrations };