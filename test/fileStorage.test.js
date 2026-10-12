const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createFileStorage } = require('../src/services/fileStorage');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const r2Environment = {
  STORAGE_PROVIDER: 'r2',
  R2_ACCOUNT_ID: 'account-id',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET_NAME: 'private-print-files',
};

test('R2 storage writes, reads, checks, and deletes objects in the private bucket', async () => {
  const objects = new Map();
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      const { Key } = command.input;
      if (command instanceof PutObjectCommand) objects.set(Key, command.input.Body);
      if (command instanceof GetObjectCommand) {
        if (!objects.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => objects.get(Key) } };
      }
      if (command instanceof DeleteObjectCommand) objects.delete(Key);
      return {};
    },
  };
  const storage = createFileStorage({ environment: r2Environment, client });
  const bytes = Buffer.from('private print document');

  await storage.put('order.pdf', bytes, 'application/pdf');
  assert.deepEqual(await storage.get('order.pdf'), bytes);
  await storage.delete('order.pdf');
  assert.deepEqual(commands.map((command) => command.constructor), [
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
  ]);
  assert.equal(commands[0].input.Bucket, r2Environment.R2_BUCKET_NAME);
  assert.equal(commands[0].input.ACL, undefined);
  await assert.rejects(storage.get('missing.pdf'), { code: 'ENOENT' });
  await assert.rejects(storage.get('order.pdf'), { code: 'ENOENT' });
});

test('R2 configuration is rejected when a required credential is missing', () => {
  assert.throws(
    () => createFileStorage({ environment: { ...r2Environment, R2_SECRET_ACCESS_KEY: '' } }),
    /Cloudflare R2 requires/,
  );
});

test('local storage keeps the same storage interface for development', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-storage-'));
  try {
    const storage = createFileStorage({ environment: { UPLOAD_DIR: directory } });
    const bytes = Buffer.from('local print document');
    await storage.put('local.pdf', bytes, 'application/pdf');
      assert.deepEqual(await storage.get('local.pdf'), bytes);
      await storage.delete('local.pdf');
      await assert.rejects(storage.get('local.pdf'), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
