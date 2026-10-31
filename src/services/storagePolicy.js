const path = require('node:path');

function isSafeStoredFilename(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value || value === '' || value === '.' || value === '..') return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.includes('/') || normalized.includes('\\')) return false;
  return path.basename(normalized) === normalized;
}

module.exports = { isSafeStoredFilename };
