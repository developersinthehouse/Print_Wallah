'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');

const router = express.Router();
const uploadDirectory = process.env.CUSTOMER_UPLOAD_DIR
  ? path.resolve(process.env.CUSTOMER_UPLOAD_DIR)
  : path.resolve(__dirname, '..', 'uploads', 'customer');
const maxFileSize = 25 * 1024 * 1024;
const orderLifetimeMs = 30 * 60 * 1000;
const cleanupIntervalMs = 5 * 60 * 1000;
const allowedFiles = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.png', new Set(['image/png'])],
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])]
]);

fs.mkdirSync(uploadDirectory, { recursive: true });

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, uploadDirectory),
  filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});

const upload = multer({
  storage,
  limits: { fileSize: maxFileSize, files: 1, fields: 6, parts: 7 },
  fileFilter: (_request, file, callback) => {
    const mimeTypes = allowedFiles.get(path.extname(file.originalname).toLowerCase());
    if (!mimeTypes || !mimeTypes.has(file.mimetype)) return callback(new Error('Only PDF, PNG, and JPG files are allowed.'));
    return callback(null, true);
  }
});

function getShopResolver(request) {
  const { getShopById, shops } = request.app.locals;
  if (typeof getShopById === 'function') return (shopId) => getShopById(shopId);
  if (shops instanceof Map) return async (shopId) => shops.get(shopId);
  if (shops && typeof shops === 'object') return async (shopId) => shops[shopId];
  return null;
}

function normalizeShop(shop) {
  if (!shop || typeof shop !== 'object') return null;
  const rates = shop.rates || shop.printRates;
  const upiVpa = String(shop.upiVpa || shop.vpa || '').trim();
  if (!rates || !/^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$/.test(upiVpa)) return null;
  const bw = Number(rates.bw);
  const color = Number(rates.color);
  if (!Number.isFinite(bw) || bw < 0 || !Number.isFinite(color) || color < 0) return null;
  return { id: String(shop.id || shop.shopId || shop._id || ''), name: String(shop.name || shop.shopName || 'Print shop'), upiVpa, rates: { bw, color } };
}

async function findShop(request, shopId) {
  const resolver = getShopResolver(request);
  if (!resolver) return { unavailable: true };
  const resolvedShop = await resolver(shopId);
  if (resolvedShop && resolvedShop.subscription_status !== undefined) {
    const expiry = new Date(resolvedShop.subscription_expiry_date).getTime();
    if (resolvedShop.subscription_status !== 'ACTIVE' || !Number.isFinite(expiry) || expiry <= Date.now()) {
      return { missing: true };
    }
  }
  const shop = normalizeShop(resolvedShop);
  return shop ? { shop } : { missing: true };
}

async function hasExpectedSignature(file) {
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const signature = buffer.subarray(0, bytesRead);
    switch (path.extname(file.originalname).toLowerCase()) {
      case '.pdf': return signature.subarray(0, 5).toString('ascii') === '%PDF-';
      case '.png': return signature.length >= 8 && signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      case '.jpg':
      case '.jpeg': return signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
      default: return false;
    }
  } finally { await handle.close(); }
}

async function getActualPageCount(file) {
  if (path.extname(file.originalname).toLowerCase() !== '.pdf') return 1;
  try {
    const document = await PDFDocument.load(await fs.promises.readFile(file.path));
    return document.getPageCount();
  } catch {
    return null;
  }
}

function makeUpiUrl(shop, order) {
  const parameters = new URLSearchParams({ pa: shop.upiVpa, pn: shop.name, am: order.amount.toFixed(2), cu: 'INR', tn: `Print order ${order.orderId}`, tr: order.orderId });
  return `upi://pay?${parameters.toString()}`;
}

async function cleanExpiredUploads({ expirePendingOrders, listActiveFiles }) {
  const activeFilePaths = new Set();
  const now = Date.now();
  await expirePendingOrders(new Date(now));
  const activeStorageKeys = await listActiveFiles();
  for (const storageKey of activeStorageKeys) {
    if (typeof storageKey === 'string' && path.basename(storageKey) === storageKey) {
      activeFilePaths.add(path.resolve(uploadDirectory, storageKey));
    }
  }

  const files = await fs.promises.readdir(uploadDirectory, { withFileTypes: true });
  await Promise.all(files.filter((file) => file.isFile()).map(async (file) => {
    const filePath = path.resolve(uploadDirectory, file.name);
    if (activeFilePaths.has(filePath)) return;
    try {
      const details = await fs.promises.stat(filePath);
      if (now - details.mtimeMs >= orderLifetimeMs) await fs.promises.unlink(filePath);
    } catch (_error) {
      // A file can disappear between the directory scan and stat/unlink.
    }
  }));
}

function startCustomerOrderCleanup(services) {
  const cleanup = () => cleanExpiredUploads(services).catch(() => { });
  const cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  cleanup();
  return () => clearInterval(cleanupTimer);
}

router.get('/shops/:shopId', async (request, response) => {
  try {
    const result = await findShop(request, request.params.shopId);
    if (result.unavailable) return response.status(503).json({ success: false, message: 'Shop settings are not connected to the customer service.' });
    if (result.missing) return response.status(404).json({ success: false, message: 'This print shop could not be found or is missing payment settings.' });
    return response.json({
      success: true, shop: {
        id: result.shop.id || request.params.shopId,
        name: result.shop.name,
        upiVpa: result.shop.upiVpa,
        rates: result.shop.rates,
      }
    });
  } catch (_error) { return response.status(500).json({ success: false, message: 'Could not load shop details.' }); }
});

router.post('/orders', (request, response) => {
  upload.single('file')(request, response, async (uploadError) => {
    if (uploadError) {
      const status = uploadError instanceof multer.MulterError && uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return response.status(status).json({ success: false, message: uploadError.message || 'Invalid upload.' });
    }
    const uploadedPath = request.file && request.file.path;
    try {
      if (!request.file) return response.status(400).json({ success: false, message: 'A document is required.' });
      if (!(await hasExpectedSignature(request.file))) {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        return response.status(400).json({ success: false, message: 'The file content does not match its extension.' });
      }
      const shopId = String(request.body.shopId || '').trim();
      if (!shopId || shopId.length > 120) {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        return response.status(400).json({ success: false, message: 'A valid shop is required.' });
      }
      const shopResult = await findShop(request, shopId);
      if (shopResult.unavailable || shopResult.missing) {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        const status = shopResult.unavailable ? 503 : 404;
        return response.status(status).json({ success: false, message: shopResult.unavailable ? 'Shop settings are not connected to the customer service.' : 'This print shop could not be found.' });
      }
      const pageCount = Number(request.body.pageCount);
      const copies = Number(request.body.copies);
      const colorMode = request.body.colorMode;
      const actualPageCount = await getActualPageCount(request.file);
      if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 500 ||
        actualPageCount === null || actualPageCount < 1 || actualPageCount > 500 || pageCount !== actualPageCount ||
        !Number.isInteger(copies) || copies < 1 || copies > 100 || !['bw', 'color'].includes(colorMode)) {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        return response.status(400).json({ success: false, message: 'Print settings are invalid or the page count does not match the document.' });
      }

      const shop = shopResult.shop;
      const amountPaise = Math.round(pageCount * copies * shop.rates[colorMode] * 100);
      if (!Number.isSafeInteger(amountPaise)) {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        return response.status(400).json({ success: false, message: 'The calculated print price is outside the supported range.' });
      }
      const amount = amountPaise / 100;
      const orderId = crypto.randomUUID();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + orderLifetimeMs);
      const createCustomerOrder = request.app.locals.createCustomerOrder;
      if (typeof createCustomerOrder !== 'function') {
        await fs.promises.unlink(uploadedPath).catch(() => { });
        return response.status(503).json({ success: false, message: 'Customer orders are not connected to order storage.' });
      }
      const order = {
        id: orderId,
        orderId,
        shopId,
        shopName: shop.name,
        fileUrl: `/api/shops/${encodeURIComponent(shopId)}/print-jobs/${encodeURIComponent(orderId)}/file`,
        storageKey: path.basename(uploadedPath),
        originalFileName: path.basename(request.file.originalname).slice(0, 180),
        fileSize: request.file.size,
        documentName: path.basename(request.file.originalname).slice(0, 180),
        fileName: path.basename(request.file.originalname).slice(0, 180),
        pageCount: actualPageCount,
        copies,
        colorMode,
        amount,
        totalAmount: amount,
        status: 'AWAITING_PAYMENT',
        createdAt,
        expiresAt,
      };
      await createCustomerOrder(order);
      order.upiUrl = makeUpiUrl(shop, order);
      return response.status(201).json({
        success: true,
        order: { orderId, shopName: order.shopName, pageCount, copies, colorMode, amount, status: order.status, upiUrl: order.upiUrl, expiresAt: order.expiresAt.toISOString() }
      });
    } catch (_error) {
      if (uploadedPath) await fs.promises.unlink(uploadedPath).catch(() => { });
      return response.status(500).json({ success: false, message: 'Could not create the print order.' });
    }
  });
});

module.exports = router;
module.exports.uploadDirectory = uploadDirectory;
module.exports.startCustomerOrderCleanup = startCustomerOrderCleanup;
