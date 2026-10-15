const path = require('node:path');

function isSafeStoredFilename(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value || value === '' || value === '.' || value === '..') return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized.includes('\\')) return false;
  return path.basename(normalized) === normalized;
}

function hasPersistentUploadDirectory(environment = process.env) {
  if (environment.NODE_ENV !== 'production') return true;
  return typeof environment.UPLOAD_DIR === 'string' &&
    environment.UPLOAD_DIR.trim() !== '' &&
    path.isAbsolute(environment.UPLOAD_DIR);
}

module.exports = { hasPersistentUploadDirectory, isSafeStoredFilename };