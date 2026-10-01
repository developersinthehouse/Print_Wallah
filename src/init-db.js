require('dotenv').config();
const { initialize, pool } = require('./db');

initialize().then(() => console.log('Database schema initialized. Super Admin credentials are read from .env at sign-in.'))
  .catch((error) => { console.error('Database initialization failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
