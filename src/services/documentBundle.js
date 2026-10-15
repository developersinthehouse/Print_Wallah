const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const { isSafeStoredFilename } = require('./storagePolicy');

const PAPER_POINTS = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
};
const MARGIN_POINTS = 12;
const IMAGE_DPI = 150;

async function appendImagePage(document, bytes, mimeType, config) {
  const image = mimeType === 'image/png'
    ? await document.embedPng(bytes)
    : mimeType === 'image/jpeg'
      ? await document.embedJpg(bytes)
      : null;
  if (!image) throw new Error('Only PDF, PNG and JPG files can be bundled for printing');

  const [paperWidth, paperHeight] = PAPER_POINTS[config.paperSize] || PAPER_POINTS.A4;
  const [pageWidth, pageHeight] = config.orientation === 'landscape'
    ? [paperHeight, paperWidth]
    : [paperWidth, paperHeight];
  const page = document.addPage([pageWidth, pageHeight]);
  let width;
  let height;

  if (config.scaling === 'actual') {
    const scale = 72 / IMAGE_DPI;
    width = image.width * scale;
    height = image.height * scale;
  } else {
    const availableWidth = config.scaling === 'fill' ? pageWidth : pageWidth - MARGIN_POINTS * 2;
    const availableHeight = config.scaling === 'fill' ? pageHeight : pageHeight - MARGIN_POINTS * 2;
    const widthScale = availableWidth / image.width;
    const heightScale = availableHeight / image.height;
    const scale = config.scaling === 'fill'
      ? Math.max(widthScale, heightScale)
      : Math.min(widthScale, heightScale);
    width = image.width * scale;
    height = image.height * scale;
  }

  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  });
}

async function createDocumentBundle(items, outputPath, config, uploadDir) {
  if (!Array.isArray(items) || items.length < 2) {
    throw new TypeError('A document bundle requires at least two uploaded files');
  }
  const output = await PDFDocument.create();

  for (const item of items) {
    const storedName = item.upload?.stored_name;
    if (!isSafeStoredFilename(storedName)) {
      throw new Error('Uploaded document has an invalid stored filename');
    }
    const filePath = path.join(uploadDir, storedName);
    const bytes = await fs.readFile(filePath);

    if (item.upload.mime_type === 'application/pdf') {
      const source = await PDFDocument.load(bytes);
      const pages = await output.copyPages(source, source.getPageIndices());
      for (const page of pages) output.addPage(page);
    } else {
      await appendImagePage(output, bytes, item.upload.mime_type, config);
    }
  }

  if (output.getPageCount() < 1) throw new Error('The document bundle contains no printable pages');
  await fs.writeFile(outputPath, await output.save());
  return output.getPageCount();
}

module.exports = { createDocumentBundle };