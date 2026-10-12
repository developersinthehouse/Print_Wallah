const fs = require('node:fs/promises');
const path = require('node:path');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { isSafeStoredFilename } = require('./storagePolicy');

function isNotFound(error) {
  return error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey' ||
    error?.$metadata?.httpStatusCode === 404;
}

function missingFileError(key) {
  const error = new Error(`Stored file does not exist: ${key}`);
  error.code = 'ENOENT';
  return error;
}

function createFileStorage({ environment = process.env, client } = {}) {
  const provider = environment.STORAGE_PROVIDER || 'local';

  if (provider === 'r2') {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = environment;
    if (![R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME].every((value) => String(value || '').trim())) {
      throw new Error('Cloudflare R2 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME');
    }
    const s3 = client || new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
    const keyFor = (key) => {
      if (!isSafeStoredFilename(key)) throw new Error('Invalid stored filename');
      return key;
    };
    return {
      provider,
      async put(key, body, contentType) {
        await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET_NAME, Key: keyFor(key), Body: body, ContentType: contentType }));
      },
      async get(key) {
        try {
          const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: keyFor(key) }));
          return Buffer.from(await result.Body.transformToByteArray());
        } catch (error) {
          if (isNotFound(error)) throw missingFileError(key);
          throw error;
        }
      },
      async delete(key) {
        await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: keyFor(key) }));
      },
    };
  }

  if (provider !== 'local') throw new Error(`Unsupported STORAGE_PROVIDER: ${provider}`);
  const directory = path.resolve(environment.UPLOAD_DIR || './storage');
  return {
    provider,
    directory,
    async put(key, body) {
      if (!isSafeStoredFilename(key)) throw new Error('Invalid stored filename');
      await fs.writeFile(path.join(directory, key), body, { flag: 'wx' });
    },
    async get(key) {
      if (!isSafeStoredFilename(key)) throw new Error('Invalid stored filename');
      return fs.readFile(path.join(directory, key));
    },
    async delete(key) {
      if (!isSafeStoredFilename(key)) throw new Error('Invalid stored filename');
      await fs.rm(path.join(directory, key), { force: true });
    },
  };
}

const fileStorage = createFileStorage();

module.exports = { createFileStorage, fileStorage };
