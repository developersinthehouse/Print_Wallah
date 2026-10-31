const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createFileStorage, fileStorage } = require('../src/services/fileStorage');

test('application storage defaults to Cloudflare R2 instead of a machine-local folder', () => {
  const previous = process.env.STORAGE_PROVIDER;
  try {
    delete process.env.STORAGE_PROVIDER;
    assert.equal(fileStorage.provider, 'r2');
  } finally {
    if (previous === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = previous;
  }
});

function fakeS3Client() {
  const objects = new Map();
  return {
    async send(command) {
      const { Bucket, Key, Body, ContentType } = command.input;
      assert.equal(Bucket, 'print-files');
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(Key, { body: Buffer.from(Body), contentType: ContentType });
        return {};
      }
      if (command.constructor.name === 'GetObjectCommand') {
        if (!objects.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { async transformToByteArray() { return objects.get(Key).body; } } };
      }
      if (command.constructor.name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
      throw new Error(`Unexpected S3 operation: ${command.constructor.name}`);
    },
    objects,
  };
}

const r2Environment = { STORAGE_PROVIDER: 'r2', R2_ACCOUNT_ID: 'account-id', R2_ACCESS_KEY_ID: 'access-key', R2_SECRET_ACCESS_KEY: 'secret-key', R2_BUCKET_NAME: 'print-files' };

test('Cloudflare R2 writes, reads, and deletes private objects', async () => {
  const client = fakeS3Client();
  const storage = createFileStorage({ environment: r2Environment, client });
  const bytes = Buffer.from('private print document');
  await storage.put('order.pdf', bytes, 'application/pdf');
  assert.deepEqual(await storage.get('order.pdf'), bytes);
  assert.equal(client.objects.get('order.pdf').contentType, 'application/pdf');
  await storage.delete('order.pdf');
  await assert.rejects(storage.get('order.pdf'), { code: 'ENOENT' });
});

test('Cloudflare R2 rejects unsafe object names', async () => {
  const storage = createFileStorage({ environment: r2Environment, client: fakeS3Client() });
  await assert.rejects(storage.put('../escape.pdf', Buffer.from('x')), /Invalid stored filename/);
  await assert.rejects(storage.get('folder/file.pdf'), /Invalid stored filename/);
});

test('local storage remains available for isolated unit tests', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-storage-'));
  try {
    const storage = createFileStorage({ environment: { STORAGE_PROVIDER: 'local', UPLOAD_DIR: directory } });
    const bytes = Buffer.from('isolated test document');
    await storage.put('local.pdf', bytes, 'application/pdf');
    assert.deepEqual(await storage.get('local.pdf'), bytes);
    await storage.delete('local.pdf');
    await assert.rejects(storage.get('local.pdf'), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
