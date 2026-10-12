const path = require('node:path');

function isSafeStoredFilename(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value || value === '' || value === '.' || value === '..') return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized.includes('\\')) return false;
  return path.basename(normalized) === normalized;
}

function hasPersistentUploadDirectory(environment = process.env) {
  if (environment.STORAGE_PROVIDER === 'r2') {
    return ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']
      .every((key) => typeof environment[key] === 'string' && environment[key].trim() !== '');
  }
  if (environment.NODE_ENV !== 'production') return true;
  return typeof environment.UPLOAD_DIR === 'string' &&
    environment.UPLOAD_DIR.trim() !== '' &&
    path.isAbsolute(environment.UPLOAD_DIR);
}

module.exports = { hasPersistentUploadDirectory, isSafeStoredFilename };