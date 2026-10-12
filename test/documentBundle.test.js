const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PDFDocument } = require('pdf-lib');
const { createDocumentBundle } = require('../src/services/documentBundle');

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');

test('document bundle merges every PDF page and embeds an image as one page', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const contents = new Map([
    ['source.pdf', Buffer.from(await pdf.save())],
    ['photo.png', ONE_PIXEL_PNG],
  ]);
  const storage = { get: async (key) => contents.get(key) };

  const result = await createDocumentBundle([
    { upload: { stored_name: 'source.pdf', mime_type: 'application/pdf' } },
    { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
  ], { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' }, storage);

  const combined = await PDFDocument.load(result.bytes);
  assert.equal(result.pages, 3);
  assert.equal(combined.getPageCount(), 3);
});

test('document bundle rejects path traversal filenames', async () => {
  await assert.rejects(
    createDocumentBundle(
      [
        { upload: { stored_name: '../outside.pdf', mime_type: 'application/pdf' } },
        { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
      ],
      { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
      { get: async () => Buffer.alloc(0) },
    ),
    /invalid stored filename/,
  );
});

test('document bundle rejects empty and dot-directory stored names', async () => {
  await assert.rejects(
    createDocumentBundle(
      [
        { upload: { stored_name: '', mime_type: 'application/pdf' } },
        { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
      ],
      { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
      { get: async () => Buffer.alloc(0) },
    ),
    /invalid stored filename/,
  );

  await assert.rejects(
    createDocumentBundle(
      [
        { upload: { stored_name: '..', mime_type: 'application/pdf' } },
        { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
      ],
      { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
      { get: async () => Buffer.alloc(0) },
    ),
    /invalid stored filename/,
  );
});