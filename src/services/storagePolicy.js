const path = require('node:path');

function hasPersistentUploadDirectory(environment = process.env) {
  if (environment.NODE_ENV !== 'production') return true;
  return typeof environment.UPLOAD_DIR === 'string' &&
    environment.UPLOAD_DIR.trim() !== '' &&
    path.isAbsolute(environment.UPLOAD_DIR);
}

module.exports = { hasPersistentUploadDirectory };