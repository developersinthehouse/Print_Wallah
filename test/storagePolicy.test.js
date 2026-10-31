const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isSafeStoredFilename } = require('../src/services/storagePolicy');

test('stored R2 object names reject paths and dot directories', () => {
  assert.equal(isSafeStoredFilename('order-file.pdf'), true);
  assert.equal(isSafeStoredFilename('../secrets.json'), false);
  assert.equal(isSafeStoredFilename('folder/file.pdf'), false);
  assert.equal(isSafeStoredFilename('.'), false);
});
