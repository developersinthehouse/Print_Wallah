const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hasPersistentUploadDirectory } = require('../src/services/storagePolicy');

test('local development may use the default relative upload directory', () => {
  assert.equal(hasPersistentUploadDirectory({ NODE_ENV: 'development' }), true);
});

test('production uploads require an explicit absolute mounted path', () => {
  assert.equal(hasPersistentUploadDirectory({ NODE_ENV: 'production' }), false);
  assert.equal(hasPersistentUploadDirectory({ NODE_ENV: 'production', UPLOAD_DIR: './storage' }), false);
  assert.equal(hasPersistentUploadDirectory({ NODE_ENV: 'production', UPLOAD_DIR: '/var/data/print-wallah' }), true);
});