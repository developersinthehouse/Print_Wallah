const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { PDFDocument } = require('pdf-lib');
const { createDocumentBundle } = require('../src/services/documentBundle');

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');

test('document bundle merges every PDF page and embeds an image as one page', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-bundle-'));
  const sourcePdf = path.join(directory, 'source.pdf');
  const imagePath = path.join(directory, 'photo.png');
  const outputPath = path.join(directory, 'combined.pdf');
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    await fs.writeFile(sourcePdf, await pdf.save());
    await fs.writeFile(imagePath, ONE_PIXEL_PNG);

    const pageCount = await createDocumentBundle([
      { upload: { stored_name: 'source.pdf', mime_type: 'application/pdf' } },
      { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
    ], outputPath, { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' }, directory);

    const combined = await PDFDocument.load(await fs.readFile(outputPath));
    assert.equal(pageCount, 3);
    assert.equal(combined.getPageCount(), 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('document bundle rejects path traversal filenames', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-bundle-'));
  try {
    await assert.rejects(
      createDocumentBundle(
        [
          { upload: { stored_name: '../outside.pdf', mime_type: 'application/pdf' } },
          { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
        ],
        path.join(directory, 'combined.pdf'),
        { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
        directory,
      ),
      /invalid stored filename/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('document bundle rejects empty and dot-directory stored names', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'print-wallah-bundle-'));
  try {
    await assert.rejects(
      createDocumentBundle(
        [
          { upload: { stored_name: '', mime_type: 'application/pdf' } },
          { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
        ],
        path.join(directory, 'combined.pdf'),
        { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
        directory,
      ),
      /invalid stored filename/,
    );

    await assert.rejects(
      createDocumentBundle(
        [
          { upload: { stored_name: '..', mime_type: 'application/pdf' } },
          { upload: { stored_name: 'photo.png', mime_type: 'image/png' } },
        ],
        path.join(directory, 'combined.pdf'),
        { paperSize: 'A4', orientation: 'portrait', scaling: 'fit' },
        directory,
      ),
      /invalid stored filename/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});