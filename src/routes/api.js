const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { createDocumentBundle } = require('../services/documentBundle');
const { COLLECTIONS, findOne, getDb, getDoc, listDocs, newId, updateDoc } = require('../firestoreStore');
const { fileStorage } = require('../services/fileStorage');
const { issue, authenticate, role } = require('../middleware/auth');
const { OPTIONAL_PRICING_KEYS, DEFAULT_PRICING, DEFAULT_PRINT_CONFIG, isActive, statusOf, calculatePrice, publicId, orderCode, token, sha256 } = require('../services/core');
const { audit } = require('../services/audit');
const { isValidUpiId, normalizeUpiId, buildUpiUri, upiQr } = require('../services/upi');
const { webhookEnabled, verifySignature } = require('../services/webhook');
const { baseUrl } = require('../services/network');
const { parseAnalyticsRange, queryPlatformAnalytics, queryShopAnalytics } = require('../services/reports');
const { isSafeStoredFilename } = require('../services/storagePolicy');

const router = express.Router();
const MAX_DOCUMENT_BUNDLE_FILES = 10;
const MAX_DOCUMENT_BUNDLE_BYTES = 100 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 30) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Upload a PDF, JPG, or PNG file')),
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = authenticate;
const ensureActiveShop = asyncRoute(async (req, res, next) => {
  const shop = await getDoc(COLLECTIONS.shops, req.user.shopId);
  if (!shop) { res.clearCookie('session', { path: '/' }); return res.status(401).json({ error: 'Shop account no longer exists. Please sign in again.' }); }
  if (req.user.pv !== sessionStamp(shop)) { res.clearCookie('session', { path: '/' }); return res.status(401).json({ error: 'Your login details changed. Please sign in again.' }); }
  if (!isActive(shop)) return res.status(423).json({ error: `Shop access is ${statusOf(shop)}` });
  next();
});
const admin = [auth, role('shop_admin'), ensureActiveShop];
const owner = [auth, role('super_admin')];
const json = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const safeShop = (shop) => ({
  id: shop.public_id, name: shop.name, ownerName: shop.owner_name, phone: shop.phone, email: shop.email,
  address: shop.address, city: shop.city, adminEmail: shop.admin_email,
  pricing: json(shop.pricing), printConfig: json(shop.print_config), upiId: shop.upi_id, upiName: shop.upi_name,
  accessStart: shop.access_start, accessEnd: shop.access_end, status: statusOf(shop),
  agentName: shop.agent_name, agentLastSeen: shop.agent_last_seen,
});
async function findShop(publicIdValue) { return findOne(COLLECTIONS.shops, 'public_id', String(publicIdValue || '').toUpperCase()); }
const sessionStamp = (shop) => sha256(`${shop.admin_password_hash}|${shop.admin_email}`).slice(0, 16);
function checkShopAdmin(req, res, next) { if (req.user.shopId !== req.params.shopId) return res.status(404).json({ error: 'Shop not found' }); next(); }
function apiShop(req, res, next) { if (req.user.shopPublicId !== req.params.shopId) return res.status(404).json({ error: 'Shop not found' }); next(); }
async function agentShop(req) {
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!supplied) return null;
  const shop = await findShop(req.params.shopId);
  return shop?.agent_token_hash === sha256(supplied) ? shop : null;
}
function validatePricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw Object.assign(new Error('Pricing must be an object of per-sheet rates'), { status: 400 });
  const out = { ...DEFAULT_PRICING, ...pricing };
  for (const key of OPTIONAL_PRICING_KEYS) if (out[key] === '' || out[key] === null || Number.isNaN(out[key])) delete out[key];
  for (const [key, value] of Object.entries(out)) if (!/^[a-z0-9_]+$/.test(key) || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000) throw Object.assign(new Error(`Invalid price: ${key}`), { status: 400 });
  return out;
}
function validatePrintConfig(value) {
  if (value && (typeof value !== 'object' || Array.isArray(value))) throw Object.assign(new Error('Printing configuration must be an object'), { status: 400 });
  const config = { ...DEFAULT_PRINT_CONFIG, ...value };
  if (!Array.isArray(config.paperSizes) || !Array.isArray(config.paperTypes)) throw Object.assign(new Error('Paper sizes and types must be lists'), { status: 400 });
  config.paperSizes = [...new Set(config.paperSizes.map(v => String(v).toUpperCase()).filter(v => ['A4', 'A3'].includes(v)))];
  config.paperTypes = [...new Set(config.paperTypes.map(v => String(v).toLowerCase()).filter(v => ['normal', 'glossy'].includes(v)))];
  if (!config.paperSizes.length || !config.paperTypes.length) throw Object.assign(new Error('Enable at least one paper size and one paper type'), { status: 400 });
  config.defaultPaper = config.paperSizes.includes(String(config.defaultPaper).toUpperCase()) ? String(config.defaultPaper).toUpperCase() : config.paperSizes[0];
  config.color = config.color === true; config.duplex = config.duplex === true; config.photo = config.photo === true && config.paperTypes.includes('glossy');
  return config;
}

router.get('/health', asyncRoute(async (_req, res) => { await getDb().collection(COLLECTIONS.shops).limit(1).get(); res.json({ status: 'ok' }); }));
router.get('/meta', (_req, res) => res.json({ maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 30) }));
router.get('/session', asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  if (req.user.role === 'super_admin') return res.json({ user: { role: 'super_admin', email: req.user.email } });
  if (req.user.role !== 'shop_admin') return res.json({ user: null });
  const shop = await getDoc(COLLECTIONS.shops, req.user.shopId);
  if (!shop) { res.clearCookie('session', { path: '/' }); return res.json({ user: null }); }
  res.json({ user: { role: 'shop_admin', shopId: shop.public_id, email: req.user.email, shopName: shop.name } });
}));
router.post('/auth/super/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const expectedEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const expectedPassword = String(process.env.SUPER_ADMIN_PASSWORD || '');
  if (!expectedEmail || !expectedPassword || email !== expectedEmail || !safeEqual(password, expectedPassword)) { console.warn(`Super Admin sign-in rejected: ${!expectedEmail || !expectedPassword ? 'SUPER_ADMIN_EMAIL/PASSWORD not configured' : email !== expectedEmail ? 'email does not match SUPER_ADMIN_EMAIL' : 'password does not match SUPER_ADMIN_PASSWORD'} (the server reads .env only when it starts)`); return res.status(401).json({ error: 'Email or password is incorrect' }); }
  issue(res, { role: 'super_admin', email }); res.json({ user: { role: 'super_admin', email } });
}));
router.post('/auth/shop/login', asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const shop = await findOne(COLLECTIONS.shops, 'admin_email', email);
  if (!shop || !(await bcrypt.compare(String(req.body.password || ''), shop.admin_password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
  if (!isActive(shop)) return res.status(423).json({ error: `This shop is ${statusOf(shop)}. Contact the platform administrator.` });
  issue(res, { role: 'shop_admin', shopId: shop.id, shopPublicId: shop.public_id, email, pv: sessionStamp(shop) }); res.json({ user: { role: 'shop_admin', shopId: shop.public_id, email, shopName: shop.name } });
}));
router.post('/auth/logout', (_req, res) => { res.clearCookie('session', { path: '/' }); res.json({ ok: true }); });

// Platform owner endpoints
router.get('/super/overview', ...owner, asyncRoute(async (_req, res) => {
  const [shops, orders] = await Promise.all([
    listDocs(COLLECTIONS.shops), listDocs(COLLECTIONS.orders, { orderBy: ['created_at', 'desc'] }),
  ]);
  const now = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const shopStats = { total: shops.length, active: 0, locked: 0, expired: 0, expiring: 0 };
  for (const shop of shops) {
    const end = new Date(shop.access_end).getTime();
    if (shop.manually_locked) shopStats.locked += 1;
    else if (end <= now) shopStats.expired += 1;
    else { shopStats.active += 1; if (end <= now + 7 * 86400000) shopStats.expiring += 1; }
  }
  const orderStats = { total: orders.length, today: 0, pages: 0, verified_revenue: 0 };
  for (const order of orders) {
    if (String(order.created_at).slice(0, 10) === today) orderStats.today += 1;
    orderStats.pages += Number(order.config?.billablePages || 0);
    if (order.payment_method === 'upi' && order.payment_status === 'verified') orderStats.verified_revenue += Number(order.amount || 0);
  }
  const shopName = new Map(shops.map((shop) => [shop.id, shop.name]));
  const recent = orders.slice(0, 8).map((order) => ({ order_code: order.order_code, amount: order.amount, order_status: order.order_status, created_at: order.created_at, shop_name: shopName.get(order.shop_id) || '' }));
  res.json({ shops: shopStats, orders: orderStats, recent });
}));
router.get('/super/analytics', ...owner, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const shops = await queryPlatformAnalytics(getDb(), range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, shops });
}));
router.get('/admin/analytics', ...admin, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const rows = await queryShopAnalytics(getDb(), req.user.shopId, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, rows });
}));
router.get('/super/shops', ...owner, asyncRoute(async (req, res) => {
  const search = String(req.query.q || '').trim().toLocaleLowerCase();
  const shops = await listDocs(COLLECTIONS.shops, { orderBy: ['created_at', 'desc'] });
  res.json(shops.filter((shop) => !search || [shop.name, shop.owner_name, shop.public_id, shop.city].some((value) => String(value || '').toLocaleLowerCase().includes(search))).map(safeShop));
}));
router.post('/super/shops', ...owner, asyncRoute(async (req, res) => {
  const b = req.body;
  for (const key of ['name', 'ownerName', 'phone', 'address', 'city', 'adminEmail', 'adminPassword']) if (!String(b[key] || '').trim()) return res.status(400).json({ error: `${key} is required` });
  if (String(b.adminPassword).length < 10) return res.status(400).json({ error: 'Shop admin password must be at least 10 characters' });
  const days = Number(b.accessDays || process.env.DEFAULT_ACCESS_DAYS || 30);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Access duration must be between 1 and 3650 days' });
  const upiId = normalizeUpiId(b.upiId);
  if (upiId && !isValidUpiId(upiId)) return res.status(400).json({ error: 'Enter a valid UPI ID such as shopname@bank' });
  const id = publicId(); const agentToken = token();
  const passwordHash = await bcrypt.hash(String(b.adminPassword), 12);
  const pricing = validatePricing(b.pricing || {});
  const printConfig = validatePrintConfig(b.printConfig || {});
  const now = new Date(); const shopDocId = newId(); const db = getDb();
  const shop = {
    public_id: id, name: String(b.name).trim(), owner_name: String(b.ownerName).trim(), phone: String(b.phone).trim(),
    email: b.email || null, address: String(b.address).trim(), city: String(b.city).trim(),
    admin_email: String(b.adminEmail).trim().toLowerCase(), admin_password_hash: passwordHash,
    pricing, print_config: printConfig, upi_id: upiId, upi_name: String(b.upiName || '').trim().slice(0, 60) || null,
    access_start: now.toISOString(), access_end: new Date(now.getTime() + days * 86400000).toISOString(),
    manually_locked: false, agent_token_hash: sha256(agentToken), agent_name: null, agent_last_seen: null,
    created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  const shopRef = db.collection(COLLECTIONS.shops).doc(shopDocId);
  const auditRef = db.collection(COLLECTIONS.auditLog).doc();
  try {
    await db.runTransaction(async (transaction) => {
      const duplicate = await transaction.get(db.collection(COLLECTIONS.shops).where('admin_email', '==', shop.admin_email).limit(1));
      if (!duplicate.empty) throw Object.assign(new Error('A shop already uses that admin email'), { status: 409 });
      transaction.create(shopRef, shop);
      transaction.create(auditRef, { shop_id: shopDocId, actor: req.user.email, action: 'shop.created', details: { publicId: id }, created_at: now.toISOString() });
    });
    const customerUrl = `${baseUrl(req)}/shop/${encodeURIComponent(id)}`;
    const qr = await QRCode.toDataURL(customerUrl, { errorCorrectionLevel: 'H', margin: 2, width: 480 });
    res.status(201).json({ shop: safeShop({ ...shop, id: shopDocId }), customerUrl, qr, agentToken });
  } catch (error) { if (error.status === 409) return res.status(409).json({ error: error.message }); throw error; }
}));
router.get('/super/shops/:shopId', ...owner, asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const orders = await listDocs(COLLECTIONS.orders, { filters: [['shop_id', '==', shop.id]], orderBy: ['created_at', 'desc'] });
  const now = Date.now(); const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);
  const startYear = new Date(new Date().getFullYear(), 0, 1);
  const stats = { orders: orders.length, today: 0, month_orders: 0, year_orders: 0, pages: 0, charges: 0, online_verified: 0, cash_confirmed: 0 };
  for (const order of orders) {
    const created = new Date(order.created_at).getTime(); const amount = Number(order.amount || 0);
    if (created >= startToday.getTime() && created <= now) stats.today += 1;
    if (created >= startMonth.getTime()) stats.month_orders += 1;
    if (created >= startYear.getTime()) stats.year_orders += 1;
    stats.pages += Number(order.config?.billablePages || 0); stats.charges += amount;
    if (order.payment_status === 'verified') stats.online_verified += amount;
    if (order.payment_method === 'cash' && ['print_queued', 'printing', 'completed'].includes(order.order_status)) stats.cash_confirmed += amount;
  }
  stats.charges = Number(stats.charges.toFixed(2)); stats.online_verified = Number(stats.online_verified.toFixed(2)); stats.cash_confirmed = Number(stats.cash_confirmed.toFixed(2));
  const customerUrl = `${baseUrl(req)}/shop/${encodeURIComponent(shop.public_id)}`;
  res.json({ shop: safeShop(shop), stats, recent: orders.slice(0, 12), customerUrl, qr: await QRCode.toDataURL(customerUrl, { errorCorrectionLevel: 'H', margin: 2, width: 480 }) });
}));
router.patch('/super/shops/:shopId', ...owner, asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const b = req.body;
  const pricing = b.pricing ? validatePricing(b.pricing) : shop.pricing;
  const printConfig = b.printConfig ? validatePrintConfig(b.printConfig) : shop.print_config;
  if (b.adminPassword && String(b.adminPassword).length < 10) return res.status(400).json({ error: 'Shop admin password must be at least 10 characters' });
  const passwordHash = b.adminPassword ? await bcrypt.hash(String(b.adminPassword), 12) : shop.admin_password_hash;
  const upiId = 'upiId' in b ? normalizeUpiId(b.upiId) : shop.upi_id;
  if (upiId && !isValidUpiId(upiId)) return res.status(400).json({ error: 'Enter a valid UPI ID such as shopname@bank' });
  const adminEmail = b.adminEmail ? String(b.adminEmail).trim().toLowerCase() : shop.admin_email;
  let updated;
  try {
    const db = getDb(); const shopRef = db.collection(COLLECTIONS.shops).doc(shop.id);
    updated = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(shopRef);
      if (!current.exists) return null;
      const data = current.data();
      if (adminEmail !== data.admin_email) {
        const duplicate = await transaction.get(db.collection(COLLECTIONS.shops).where('admin_email', '==', adminEmail).limit(1));
        if (duplicate.docs.some((doc) => doc.id !== shop.id)) throw Object.assign(new Error('Another shop already uses that admin email'), { status: 409 });
      }
      const patch = {
        name: b.name ?? data.name, owner_name: b.ownerName ?? data.owner_name, phone: b.phone ?? data.phone,
        email: b.email ?? data.email, address: b.address ?? data.address, city: b.city ?? data.city,
        admin_email: adminEmail, admin_password_hash: passwordHash, pricing, print_config: printConfig, upi_id: upiId,
        upi_name: 'upiName' in b ? (String(b.upiName || '').trim().slice(0, 60) || null) : data.upi_name,
        updated_at: new Date().toISOString(),
      };
      transaction.update(shopRef, patch);
      return { id: shop.id, ...data, ...patch };
    });
  }
  catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message }); throw e; }
  if (!updated) return res.status(404).json({ error: 'Shop not found' });
  await audit(shop.id, req.user.email, 'shop.updated', { fields: Object.keys(b).filter(k => k !== 'adminPassword') }); res.json({ shop: safeShop(updated) });
}));
router.post('/super/shops/:shopId/lock', ...owner, asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const locked = Boolean(req.body.locked); await updateDoc(COLLECTIONS.shops, shop.id, { manually_locked: locked });
  await audit(shop.id, req.user.email, locked ? 'shop.locked' : 'shop.unlocked'); res.json({ status: locked ? 'locked' : statusOf({ ...shop, manually_locked: false }) });
}));
router.post('/super/shops/:shopId/extend', ...owner, asyncRoute(async (req, res) => {
  const days = Number(req.body.days || 30); if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Extension must be between 1 and 3650 days' });
  const db = getDb(); const shopSnapshot = await db.collection(COLLECTIONS.shops).where('public_id', '==', req.params.shopId).limit(1).get();
  if (shopSnapshot.empty) return res.status(404).json({ error: 'Shop not found' });
  const ref = shopSnapshot.docs[0].ref; const extensionRef = db.collection(COLLECTIONS.accessExtensions).doc(); const auditRef = db.collection(COLLECTIONS.auditLog).doc();
  const result = await db.runTransaction(async (transaction) => {
    const current = await transaction.get(ref); if (!current.exists) return null;
    const shop = { id: current.id, ...current.data() }; const now = new Date();
    const previous = new Date(shop.access_end); const updatedEnd = new Date(Math.max(previous.getTime(), now.getTime()) + days * 86400000).toISOString();
    transaction.update(ref, { access_end: updatedEnd, manually_locked: false, updated_at: now.toISOString() });
    transaction.create(extensionRef, { shop_id: shop.id, days, previous_expiry: shop.access_end, new_expiry: updatedEnd, actor: req.user.email, created_at: now.toISOString() });
    transaction.create(auditRef, { shop_id: shop.id, actor: req.user.email, action: 'shop.extended', details: { days, expiresAt: updatedEnd }, created_at: now.toISOString() });
    return { ...shop, access_end: updatedEnd, manually_locked: false, updated_at: now.toISOString() };
  });
  if (!result) return res.status(404).json({ error: 'Shop not found' });
  res.json({ shop: safeShop(result) });
}));

// Customer portal endpoints: every operation binds to the URL's shop.
const agentOnline = (shop) => Boolean(shop.agent_last_seen) && Date.now() - new Date(shop.agent_last_seen).getTime() < 90000;
const publicShopView = (shop) => ({
  id: shop.public_id, name: shop.name, city: shop.city, address: shop.address, phone: shop.phone,
  pricing: json(shop.pricing), printConfig: json(shop.print_config),
  upiConfigured: isValidUpiId(shop.upi_id), printerOnline: agentOnline(shop), maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 30),
  photoSizes: Object.entries(PHOTO_SIZES).map(([id, v]) => ({ id, label: v.label, w: v.w, h: v.h })),
});
const UNPAID_UPI = ['pending_payment', 'payment_review'];

async function queueForPrintTransaction(transaction, order, { reset = false } = {}) {
  const db = getDb(); const jobRef = db.collection(COLLECTIONS.printJobs).doc(String(order.id));
  const counterRef = db.collection(COLLECTIONS.queueCounters).doc(String(order.shop_id));
  const [jobSnapshot, counterSnapshot] = await Promise.all([transaction.get(jobRef), transaction.get(counterRef)]);
  if (jobSnapshot.exists && !reset) return { id: jobSnapshot.id, ...jobSnapshot.data() };
  const position = Number(counterSnapshot.exists ? counterSnapshot.data().value : 0) + 1;
  const now = new Date().toISOString();
  transaction.set(counterRef, { value: position, updated_at: now });
  const job = {
    order_id: order.id, shop_id: order.shop_id, status: 'queued', queue_position: position,
    attempts: reset ? 0 : Number(jobSnapshot.exists ? jobSnapshot.data().attempts || 0 : 0),
    claimed_by: null, claimed_at: null, error_message: null,
    created_at: jobSnapshot.exists ? jobSnapshot.data().created_at : now, updated_at: now,
  };
  transaction.set(jobRef, job);
  return { id: jobRef.id, ...job };
}

async function orderView(order, shop, { withQr = false } = {}) {
  const payable = order.payment_method === 'upi' && order.payment_status === 'pending' && UNPAID_UPI.includes(order.order_status);
  let upi = null;
  if (payable && isValidUpiId(shop.upi_id)) {
    const uri = buildUpiUri({ upiId: shop.upi_id, payeeName: shop.upi_name || shop.name, amount: order.amount, orderCode: order.order_code });
    upi = { id: shop.upi_id, payee: shop.upi_name || shop.name, uri, qr: withQr ? await upiQr(uri) : undefined };
  }
  return {
    code: order.order_code, shopId: shop.public_id, amount: Number(order.amount), paymentMethod: order.payment_method, paymentStatus: order.payment_status,
    status: order.order_status, printStatus: order.print_status, shopName: shop.name, shopPhone: shop.phone,
    fileName: order.config?.fileName, createdAt: order.created_at, updatedAt: order.updated_at, completedAt: order.completed_at || null, reference: order.payment_reference || null, claimedAt: order.payment_claimed_at || null,
    upi, upiUrl: upi?.uri || null, upiId: upi?.id || null,
  };
}
async function loadOrderWithShop(code) {
  const order = await findOne(COLLECTIONS.orders, 'order_code', String(code || '').toUpperCase());
  if (!order) return null;
  const shop = await getDoc(COLLECTIONS.shops, order.shop_id);
  if (!shop) return null;
  return { order, shop };
}

async function enrichOrder(order) {
  const [upload, job] = await Promise.all([
    order.upload_id ? getDoc(COLLECTIONS.uploads, order.upload_id) : null,
    findOne(COLLECTIONS.printJobs, 'order_id', order.id),
  ]);
  return {
    ...order,
    original_name: upload?.original_name || '', mime_type: upload?.mime_type || '', byte_size: upload?.byte_size || 0,
    print_error: job?.error_message || null, print_attempts: job?.attempts || 0, print_queue_position: job?.queue_position ?? null,
  };
}

router.get('/shops/:shopId/public', asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'This shop portal does not exist' });
  if (!isActive(shop)) return res.status(423).json({ error: `${shop.name} is currently ${statusOf(shop)} and cannot accept orders`, status: statusOf(shop) });
  res.json({ shop: publicShopView(shop) });
}));
router.post('/shops/:shopId/uploads', upload.single('document'), asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop portal not found' });
  if (!isActive(shop)) return res.status(423).json({ error: `Shop is ${statusOf(shop)}` });
  if (!req.file) return res.status(400).json({ error: 'Choose a document to upload' });
  const bytes = req.file.buffer; const mime = detectMime(bytes);
  if (mime !== req.file.mimetype) return res.status(400).json({ error: 'The file contents do not match the selected file type' });
  let pages = 1, width = null, height = null;
  if (mime === 'application/pdf') {
    try { const parsed = await pdfParse(Uint8Array.from(bytes)); pages = parsed.numpages; if (!Number.isInteger(pages) || pages < 1 || pages > 2000) throw new Error('PDF must contain 1 to 2000 pages'); }
    catch (e) { console.error('PDF analysis rejected an upload:', e.message); return res.status(400).json({ error: e.message.includes('PDF must contain') ? e.message : 'Could not read this PDF. It may be damaged or password protected. Export or save it again and retry.' }); }
  } else {
    const size = imageSize(bytes);
    if (!size || size.width < 1 || size.height < 1) return res.status(400).json({ error: 'Could not read this image. Try saving it again as JPG or PNG.' });
    if (size.width > 12000 || size.height > 12000 || size.width * size.height > 100e6) return res.status(400).json({ error: 'This image is too large to print. Reduce it to under 12000 pixels on each side.' });
    ({ width, height } = size);
  }
  const publicToken = token();
  const originalName = path.basename(req.file.originalname).slice(0, 200);
  const storedName = `${crypto.randomUUID()}${path.extname(originalName).toLowerCase()}`;
  const uploadRef = getDb().collection(COLLECTIONS.uploads).doc(newId());
  const now = new Date();
  try {
    await fileStorage.put(storedName, bytes, mime);
    const record = { public_token: publicToken, shop_id: shop.id, original_name: originalName, stored_name: storedName, mime_type: mime, byte_size: req.file.size, page_count: pages, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(), width, height };
    await uploadRef.create(record);
    res.status(201).json({ uploadToken: publicToken, fileName: originalName, mimeType: mime, size: req.file.size, pages, width, height });
  } catch (e) { await fileStorage.delete(storedName).catch(() => {}); throw e; }
}));
router.post('/shops/:shopId/price', asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (!isActive(shop)) return res.status(423).json({ error: `Shop is ${statusOf(shop)}` });
  try {
    if (req.body.uploadToken) { // Preferred: the quote is computed exactly the way the order will be.
      const p = await prepareOrder(shop, req.body, { forQuote: true });
      return res.json({ ...p.quote, pages: p.pages, copies: p.config.copies, sheets: p.config.photoSheets || 0, photoQuantity: p.config.photoQuantity, photoCapacity: p.config.photoCapacity || 0 });
    }
    const pc = json(shop.print_config), paperSize = String(req.body.paperSize || pc.defaultPaper).toUpperCase(), paperType = String(req.body.paperType || 'normal').toLowerCase();
    if (!pc.paperSizes.includes(paperSize) || !pc.paperTypes.includes(paperType)) throw new Error('Selected paper is not available at this shop');
    const photoSheets = Number(req.body.photoSheets || 0); if (photoSheets && !pc.photo) throw new Error('Photo printing is not available at this shop');
    res.json(calculatePrice({ pricing: json(shop.pricing), pages: req.body.pages, copies: req.body.copies, color: Boolean(req.body.color) && pc.color, paperSize, paperType, duplex: Boolean(req.body.duplex) && pc.duplex && paperType === 'normal', photoSheets }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
router.post('/shops/:shopId/orders', asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (!isActive(shop)) return res.status(423).json({ error: `Shop is ${statusOf(shop)}` });
  const b = req.body || {};
  if (!['cash', 'upi'].includes(b.paymentMethod)) return res.status(400).json({ error: 'Choose cash or UPI payment' });
  // Idempotency: one upload token is one order. A double tap, retry or refresh returns the existing order instead of an error or a second order.
  const primaryUpload = await findOne(COLLECTIONS.uploads, 'public_token', String(b.uploadToken || ''));
  if (primaryUpload?.shop_id === shop.id) {
    const claim = await getDoc(COLLECTIONS.uploadOrderClaims, primaryUpload.id);
    if (claim?.order_id) {
      const existing = await getDoc(COLLECTIONS.orders, claim.order_id);
      if (existing) return res.status(200).json({ order: await orderView(existing, shop, { withQr: true }), resumed: true });
    }
  }
  if (b.paymentMethod === 'upi' && !isValidUpiId(shop.upi_id)) return res.status(400).json({ error: shop.upi_id ? 'This shop\u2019s UPI ID looks invalid. Please pay with cash or contact the shop.' : 'This shop has not configured UPI payments' });
  let prepared;
  try { prepared = await prepareOrder(shop, b); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { file, items, config, pages, quote } = prepared;
  // The price the customer saw must be the price they pay. If the shop changed its rates meanwhile, ask the customer to review.
  if (b.expectedAmount !== undefined && b.expectedAmount !== null && Math.round(Number(b.expectedAmount) * 100) !== Math.round(quote.total * 100)) return res.status(409).json({ error: `The shop's price changed. The new total is \u20B9${quote.total.toFixed(2)}. Please review it and try again.`, code: 'PRICE_CHANGED', currentAmount: quote.total });
  const code = orderCode();
  const orderStatus = b.paymentMethod === 'cash' ? 'cash_confirmation_pending' : 'pending_payment';
  const documentBundle = config.mode !== 'photo' && items.length > 1;
  const printFileName = config.mode === 'photo' || documentBundle ? `${crypto.randomUUID()}-${documentBundle ? 'document-bundle' : 'photo-sheet'}.pdf` : null;
  let generatedPdf = null;
  if (printFileName) {
    try {
      generatedPdf = documentBundle
        ? (await createDocumentBundle(items, config)).bytes
        : await createPhotoPrintFile(items, config);
      await fileStorage.put(printFileName, generatedPdf, 'application/pdf');
    } catch (e) {
      console.error('Printable PDF preparation failed:', e.message);
      if (printFileName) await fileStorage.delete(printFileName).catch(() => {});
      return res.status(400).json({ error: documentBundle ? 'Could not combine these files into one print document.' : 'Could not prepare these photos for a photo sheet. Try different JPG or PNG files.' });
    }
  }
  const db = getDb(); const orderId = newId(); const now = new Date().toISOString();
  const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
  const paymentRef = db.collection(COLLECTIONS.payments).doc(orderId);
  const codeRef = db.collection(COLLECTIONS.orderCodes).doc(code);
  const auditRef = db.collection(COLLECTIONS.auditLog).doc();
  const claimRefs = [...new Set(items.map((item) => item.upload.id))].map((uploadId) => db.collection(COLLECTIONS.uploadOrderClaims).doc(uploadId));
  const orderConfig = {
    ...config, sourcePageCount: pages, printPageCount: config.mode === 'photo' ? config.photoSheets : pages,
    fileName: config.mode === 'photo' ? `${items.length} photos` : documentBundle ? `${items.length} files` : file.original_name,
    documentFiles: documentBundle ? items.map((item) => item.upload.original_name) : undefined,
    billablePages: quote.printablePages * config.copies, priceBreakdown: quote,
  };
  const newOrder = {
    order_code: code, shop_id: shop.id, upload_id: file.id, upload_ids: [...new Set(items.map((item) => item.upload.id))],
    items: items.map((item, position) => ({ upload_id: item.upload.id, quantity: item.quantity, position })),
    print_file_name: printFileName, customer_name: String(b.customerName || '').slice(0, 100) || null,
    customer_phone: String(b.customerPhone || '').slice(0, 40) || null, config: orderConfig, page_count: pages,
    copies: config.copies, amount: quote.total, payment_method: b.paymentMethod, payment_status: 'pending',
    order_status: orderStatus, print_status: 'not_ready', payment_reference: null, payment_claimed_at: null,
    confirmed_at: null, completed_at: null, files_deleted_at: null, created_at: now, updated_at: now,
  };
  try {
    const result = await db.runTransaction(async (transaction) => {
      const uploadRefs = [...new Set(items.map((item) => item.upload.id))].map((uploadId) => db.collection(COLLECTIONS.uploads).doc(uploadId));
      const [claims, uploadSnapshots, codeSnapshot] = await Promise.all([
        Promise.all(claimRefs.map((ref) => transaction.get(ref))),
        Promise.all(uploadRefs.map((ref) => transaction.get(ref))),
        transaction.get(codeRef),
      ]);
      const primaryClaimIndex = [...new Set(items.map((item) => item.upload.id))].indexOf(file.id);
      const prior = claims[primaryClaimIndex];
      if (prior?.exists) {
        const priorOrderRef = db.collection(COLLECTIONS.orders).doc(String(prior.data().order_id));
        const priorOrder = await transaction.get(priorOrderRef);
        if (priorOrder.exists) return { resumed: true, order: { id: priorOrder.id, ...priorOrder.data() } };
      }
      if (claims.some((claim) => claim.exists)) throw Object.assign(new Error('One of these uploads is already part of another order. Upload the files again.'), { status: 409 });
      const uploadById = new Map(uploadSnapshots.map((snapshot) => [snapshot.id, snapshot]));
      for (const item of items) {
        const snapshot = uploadById.get(item.upload.id);
        if (!snapshot?.exists || snapshot.data().shop_id !== shop.id || snapshot.data().cleanup_pending || new Date(snapshot.data().expires_at).getTime() <= Date.now()) {
          throw Object.assign(new Error('An uploaded file expired or is no longer available. Upload it again.'), { status: 410 });
        }
      }
      if (codeSnapshot.exists) throw Object.assign(new Error('Could not allocate a unique order code. Please retry.'), { status: 503 });
      transaction.create(orderRef, newOrder);
      transaction.create(codeRef, { order_id: orderId, created_at: now });
      for (const ref of claimRefs) transaction.create(ref, { order_id: orderId, shop_id: shop.id, created_at: now });
      if (b.paymentMethod === 'upi') transaction.create(paymentRef, { order_id: orderId, shop_id: shop.id, amount: quote.total, provider: 'upi_manual', status: 'pending', reference: null, verified_by: null, created_at: now, updated_at: now });
      transaction.create(auditRef, { shop_id: shop.id, actor: 'customer', action: 'order.created', details: { orderCode: code, paymentMethod: b.paymentMethod, amount: quote.total }, created_at: now });
      return { resumed: false, order: { id: orderId, ...newOrder } };
    });
    if (result.resumed) {
      if (printFileName) await fileStorage.delete(printFileName).catch(() => {});
      return res.status(200).json({ order: await orderView(result.order, shop, { withQr: true }), resumed: true });
    }
    res.status(201).json({ order: await orderView(result.order, shop, { withQr: true }) });
  } catch (e) {
    if (printFileName) await fileStorage.delete(printFileName).catch(() => {});
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

// Order lookup by its unguessable code: full view for resuming checkout after a refresh or after returning from a UPI app.
router.get('/orders/:code', asyncRoute(async (req, res) => {
  const found = await loadOrderWithShop(req.params.code); if (!found) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: await orderView(found.order, found.shop, { withQr: true }) });
}));
router.get('/orders/:code/status', asyncRoute(async (req, res) => {
  const found = await loadOrderWithShop(req.params.code); if (!found) return res.status(404).json({ error: 'Order not found' });
  const { order, shop } = found;
  let ahead = null;
  if (['print_queued', 'printing'].includes(order.order_status)) {
    const [ownJob, jobs] = await Promise.all([
      findOne(COLLECTIONS.printJobs, 'order_id', order.id),
      listDocs(COLLECTIONS.printJobs, { filters: [['shop_id', '==', order.shop_id]], orderBy: ['queue_position', 'asc'] }),
    ]);
    ahead = ownJob ? jobs.filter((job) => ['queued', 'claimed', 'printing'].includes(job.status) && Number(job.queue_position) < Number(ownJob.queue_position)).length : null;
  }
  res.json({ order_code: order.order_code, order_status: order.order_status, payment_status: order.payment_status, print_status: order.print_status, payment_method: order.payment_method, reference_received: order.payment_reference !== null, payment_claimed: order.payment_claimed_at !== null, amount: Number(order.amount), printer_online: agentOnline(shop), ahead, updated_at: order.updated_at });
}));

async function customerOrderAction(req, res, action) {
  const db = getDb();
  try {
    const reference = String(req.body?.reference || '').trim().toUpperCase();
    if (action === 'claim' && reference && !/^[A-Z0-9]{6,30}$/.test(reference)) return res.status(400).json({ error: 'A UPI transaction reference has 6 to 30 letters and numbers. Leave it blank if you do not have it.' });
    if (action === 'claim' && req.requireReference && !reference) return res.status(400).json({ error: 'Enter your UPI transaction reference' });
    const auditRef = db.collection(COLLECTIONS.auditLog).doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const matches = await transaction.get(db.collection(COLLECTIONS.orders).where('order_code', '==', String(req.params.code || '').toUpperCase()).limit(1));
      if (matches.empty) return { missing: true };
      const orderSnapshot = matches.docs[0]; const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
      const upiUnpaid = order.payment_method === 'upi' && order.payment_status === 'pending';
      let patch = null; let auditAction = null; let auditDetails = {};
      if (action === 'claim') {
        if (!upiUnpaid) throw Object.assign(new Error(order.payment_method === 'upi' ? 'This payment is already processed' : 'This is not a UPI order'), { status: 409 });
        if (order.order_status === 'payment_review' && (!reference || order.payment_reference === reference)) return { alreadyClaimed: true, order };
        if (order.order_status === 'payment_review' && order.payment_reference && order.payment_reference !== reference) throw Object.assign(new Error('A transaction reference was already submitted for this order. Contact the shop if it needs correction.'), { status: 409 });
        if (!['pending_payment', 'payment_review'].includes(order.order_status)) throw Object.assign(new Error('This order can no longer accept payment'), { status: 409 });
        patch = { order_status: 'payment_review', payment_claimed_at: order.payment_claimed_at || new Date().toISOString(), payment_reference: reference || order.payment_reference || null };
        auditAction = 'payment.claimed'; auditDetails = { orderCode: order.order_code, hasReference: Boolean(reference) };
      } else if (action === 'cancel') {
        const cashPending = order.payment_method === 'cash' && order.order_status === 'cash_confirmation_pending';
        const upiNotClaimed = upiUnpaid && order.order_status === 'pending_payment';
        if (order.order_status === 'cancelled') return { alreadyCancelled: true, order };
        if (!cashPending && !upiNotClaimed) throw Object.assign(new Error(order.order_status === 'payment_review' ? 'You already told the shop you paid. Please ask the shop to cancel this order.' : 'This order can no longer be cancelled here'), { status: 409 });
        patch = { order_status: 'cancelled', payment_status: 'cancelled' };
        auditAction = 'order.cancelled_by_customer'; auditDetails = { orderCode: order.order_code };
      } else if (action === 'switch-cash') {
        if (!(upiUnpaid && order.order_status === 'pending_payment')) throw Object.assign(new Error(order.order_status === 'payment_review' ? 'You already told the shop you paid by UPI. Ask the shop to handle this order.' : 'Payment method can no longer be changed'), { status: 409 });
        patch = { payment_method: 'cash', order_status: 'cash_confirmation_pending', payment_reference: null, payment_claimed_at: null };
        auditAction = 'order.switched_to_cash'; auditDetails = { orderCode: order.order_code };
      }
      const now = new Date().toISOString();
      transaction.update(orderSnapshot.ref, { ...patch, updated_at: now });
      if (action === 'claim' && reference) transaction.set(db.collection(COLLECTIONS.payments).doc(order.id), { reference, updated_at: now }, { merge: true });
      if (action !== 'claim' && order.payment_method === 'upi') transaction.set(db.collection(COLLECTIONS.payments).doc(order.id), { status: 'cancelled', updated_at: now }, { merge: true });
      transaction.create(auditRef, { shop_id: order.shop_id, actor: 'customer', action: auditAction, details: auditDetails, created_at: now });
      return { order: { ...order, ...patch, updated_at: now } };
    });
    if (outcome.missing) return res.status(404).json({ error: 'Order not found' });
    if (outcome.alreadyCancelled) return res.json({ ok: true });
    if (outcome.alreadyClaimed) return res.json({ ok: true, message: 'The shop has been notified and will verify your payment.' });
    const found = await loadOrderWithShop(outcome.order.order_code);
    res.json({ ok: true, order: await orderView(found.order, found.shop, { withQr: true }) });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
}
router.post('/orders/:code/payment-claim', asyncRoute((req, res) => customerOrderAction(req, res, 'claim')));
router.post('/orders/:code/payment-reference', asyncRoute((req, res) => { req.requireReference = true; return customerOrderAction(req, res, 'claim'); })); // kept for older clients
router.post('/orders/:code/cancel', asyncRoute((req, res) => customerOrderAction(req, res, 'cancel')));
router.post('/orders/:code/switch-cash', asyncRoute((req, res) => customerOrderAction(req, res, 'switch-cash')));

// Signed provider/bank confirmation. Disabled unless PAYMENT_WEBHOOK_SECRET is set. This is the only path that can verify a UPI payment without a person.
router.post('/payments/webhook', asyncRoute(async (req, res) => {
  if (!webhookEnabled()) return res.status(404).json({ error: 'Not found' });
  if (!verifySignature(req.rawBody || Buffer.alloc(0), req.get('x-pw-signature'))) return res.status(401).json({ error: 'Invalid signature' });
  const e = req.body || {};
  const eventId = typeof e.eventId === 'string' ? e.eventId.trim() : '';
  const orderCodeValue = typeof e.orderCode === 'string' ? e.orderCode.trim().toUpperCase() : '';
  const providerPaymentId = e.providerPaymentId == null ? null : typeof e.providerPaymentId === 'string' ? e.providerPaymentId.trim() : '';
  const validAmountType = typeof e.amount === 'number' || typeof e.amount === 'string' && e.amount.trim() !== '';
  const amount = validAmountType ? Number(e.amount) : NaN;
  if (!eventId || eventId.length > 200 || !orderCodeValue || orderCodeValue.length > 64 || !['paid', 'failed'].includes(e.status)) return res.status(400).json({ error: 'A 1-200 character eventId, orderCode and status (paid or failed) are required' });
  if (e.providerPaymentId != null && (!providerPaymentId || providerPaymentId.length > 100)) return res.status(400).json({ error: 'providerPaymentId must be a 1-100 character string' });
  if (e.status === 'paid' && (!validAmountType || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7 || String(e.currency || '').trim().toUpperCase() !== 'INR')) return res.status(400).json({ error: 'Paid events require a positive amount in INR with no more than two decimal places' });
  const db = getDb(); const eventRef = db.collection(COLLECTIONS.paymentEvents).doc(sha256(`webhook:${eventId}`));
  const outcome = await db.runTransaction(async (transaction) => {
    const priorEvent = await transaction.get(eventRef);
    if (priorEvent.exists) return { duplicate: true };
    const orders = await transaction.get(db.collection(COLLECTIONS.orders).where('order_code', '==', orderCodeValue).limit(1));
    const payload = { status: e.status, amount: e.amount, currency: e.currency, providerPaymentId };
    const now = new Date().toISOString();
    if (orders.empty) {
      transaction.create(eventRef, { provider: 'webhook', event_id: eventId, order_code: orderCodeValue, outcome: 'unknown_order', payload, created_at: now });
      return { httpStatus: 404, error: 'Unknown order' };
    }
    const orderSnapshot = orders.docs[0]; const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
    const paymentRef = db.collection(COLLECTIONS.payments).doc(order.id);
    await transaction.get(paymentRef);
    const recordEvent = (eventOutcome) => transaction.create(eventRef, { provider: 'webhook', event_id: eventId, order_id: order.id, order_code: orderCodeValue, outcome: eventOutcome, payload, created_at: now });
    if (order.payment_method !== 'upi') { recordEvent('not_upi'); return { httpStatus: 409, error: 'Order is not a UPI order' }; }
    if (e.status === 'failed') {
      transaction.set(paymentRef, { status: 'failed', updated_at: now }, { merge: true });
      recordEvent('provider_failed'); return { outcome: 'provider_failed' };
    }
    if (Math.round(amount * 100) !== Math.round(Number(order.amount) * 100)) {
      recordEvent('amount_mismatch');
      const auditRef = db.collection(COLLECTIONS.auditLog).doc();
      transaction.create(auditRef, { shop_id: order.shop_id, actor: 'webhook', action: 'payment.amount_mismatch', details: { orderCode: order.order_code, expected: Number(order.amount), received: e.amount }, created_at: now });
      return { httpStatus: 422, error: 'Amount or currency does not match the order' };
    }
    if (order.payment_status === 'verified') { recordEvent('already_verified'); return { outcome: 'already_verified' }; }
    if (!(order.payment_status === 'pending' && UNPAID_UPI.includes(order.order_status))) {
      recordEvent('needs_review');
      const auditRef = db.collection(COLLECTIONS.auditLog).doc();
      transaction.create(auditRef, { shop_id: order.shop_id, actor: 'webhook', action: 'payment.needs_review', details: { orderCode: order.order_code, orderStatus: order.order_status }, created_at: now });
      return { httpStatus: 202, outcome: 'needs_review' };
    }
    await queueForPrintTransaction(transaction, order);
    transaction.update(orderSnapshot.ref, { payment_status: 'verified', order_status: 'print_queued', print_status: 'queued', confirmed_at: now, payment_reference: order.payment_reference || providerPaymentId, updated_at: now });
    transaction.set(paymentRef, { status: 'verified', verified_by: 'webhook', reference: providerPaymentId || null, updated_at: now }, { merge: true });
    const auditRef = db.collection(COLLECTIONS.auditLog).doc();
    transaction.create(auditRef, { shop_id: order.shop_id, actor: 'webhook', action: 'payment.verified', details: { orderCode: order.order_code }, created_at: now });
    recordEvent('verified');
    return { outcome: 'verified' };
  });
  if (outcome.duplicate) return res.json({ ok: true, duplicate: true });
  if (outcome.httpStatus) return res.status(outcome.httpStatus).json(outcome.outcome ? { ok: true, outcome: outcome.outcome } : { error: outcome.error });
  return res.json({ ok: true, outcome: outcome.outcome });
}));

// Shop admin endpoints
router.get('/admin/me', ...admin, asyncRoute(async (req, res) => { const shop = await getDoc(COLLECTIONS.shops, req.user.shopId); if (!shop) return res.status(401).json({ error: 'Shop account no longer exists' }); if (!isActive(shop)) return res.status(423).json({ error: `Shop is ${statusOf(shop)}` }); res.json({ shop: safeShop(shop) }); }));
router.get('/admin/overview', ...admin, asyncRoute(async (req, res) => {
  const shopId = req.user.shopId;
  const [orders, shop] = await Promise.all([
    listDocs(COLLECTIONS.orders, { filters: [['shop_id', '==', shopId]], orderBy: ['created_at', 'desc'] }),
    getDoc(COLLECTIONS.shops, shopId),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const stats = { today_orders: 0, today_pages: 0, today_earnings: 0, cash_pending: 0, payment_pending: 0, awaiting_payment: 0, queue: 0 };
  for (const order of orders) {
    const isToday = String(order.created_at).slice(0, 10) === today;
    if (isToday) {
      stats.today_orders += 1; stats.today_pages += Number(order.config?.billablePages || 0);
      if (['print_queued', 'printing', 'completed'].includes(order.order_status)) stats.today_earnings += Number(order.amount || 0);
    }
    if (order.order_status === 'cash_confirmation_pending') stats.cash_pending += 1;
    if (order.order_status === 'payment_review') stats.payment_pending += 1;
    if (order.order_status === 'pending_payment') stats.awaiting_payment += 1;
    if (['queued', 'claimed', 'printing'].includes(order.print_status)) stats.queue += 1;
  }
  stats.today_earnings = Number(stats.today_earnings.toFixed(2));
  const recent = await Promise.all(orders.slice(0, 12).map(enrichOrder));
  res.json({ stats, recent, agent: { agent_name: shop?.agent_name, agent_last_seen: shop?.agent_last_seen } });
}));
router.get('/admin/print-queue', ...admin, asyncRoute(async (req, res) => {
  const jobs = await listDocs(COLLECTIONS.printJobs, { filters: [['shop_id', '==', req.user.shopId], ['status', '==', 'queued']], orderBy: ['queue_position', 'asc'] });
  const orders = await Promise.all(jobs.map((job) => getDoc(COLLECTIONS.orders, job.order_id)));
  const eligible = orders.filter((order) => order && order.order_status === 'print_queued' && order.payment_status === 'verified');
  res.json(await Promise.all(eligible.map(enrichOrder)));
}));
router.patch('/admin/print-queue', ...admin, asyncRoute(async (req, res) => {
  const orderIds = req.body?.orderIds;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!Array.isArray(orderIds) || orderIds.some((id) => typeof id !== 'string' || !uuid.test(id))) {
    return res.status(400).json({ error: 'A list of queued order IDs is required' });
  }
  const normalizedIds = orderIds.map((id) => id.toLowerCase());
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    return res.status(400).json({ error: 'Queued order IDs must be unique' });
  }

  const db = getDb(); const auditRef = db.collection(COLLECTIONS.auditLog).doc();
  const reordered = await db.runTransaction(async (transaction) => {
    const jobsQuery = db.collection(COLLECTIONS.printJobs).where('shop_id', '==', req.user.shopId).where('status', '==', 'queued').orderBy('queue_position', 'asc');
    const jobsSnapshot = await transaction.get(jobsQuery);
    const queuedJobs = jobsSnapshot.docs.map((doc) => ({ ref: doc.ref, id: doc.id, ...doc.data() }));
    if (queuedJobs.length > 498) throw Object.assign(new Error('This queue is too large to reorder safely in one operation'), { status: 409 });
    const orderSnapshots = await Promise.all(queuedJobs.map((job) => transaction.get(db.collection(COLLECTIONS.orders).doc(String(job.order_id)))));
    const counterRef = db.collection(COLLECTIONS.queueCounters).doc(String(req.user.shopId));
    const counterSnapshot = await transaction.get(counterRef);
    const current = queuedJobs.map((job, index) => ({ job, order: orderSnapshots[index] }))
      .filter(({ order }) => order.exists && order.data().order_status === 'print_queued' && order.data().payment_status === 'verified')
      .map(({ job, order }) => ({ ...job, order_code: order.data().order_code }));
    const currentIds = current.map((item) => item.id.toLowerCase());
    const requestedSet = new Set(normalizedIds);
    if (currentIds.length !== normalizedIds.length || currentIds.some((id) => !requestedSet.has(id))) return false;
    const codeById = new Map(current.map((item) => [item.id.toLowerCase(), item.order_code]));
    const now = new Date().toISOString();
    normalizedIds.forEach((id, index) => transaction.update(db.collection(COLLECTIONS.printJobs).doc(id), { queue_position: index + 1, updated_at: now }));
    transaction.set(counterRef, { value: Math.max(Number(counterSnapshot.exists ? counterSnapshot.data().value : 0), normalizedIds.length), updated_at: now });
    transaction.create(auditRef, { shop_id: req.user.shopId, actor: req.user.email, action: 'print_queue.reordered', details: { orderCodes: normalizedIds.map((id) => codeById.get(id)) }, created_at: now });
    return true;
  });
  if (!reordered) return res.status(409).json({ error: 'The print queue changed. Refresh and try again.' });
  return res.json({ ok: true });
}));
router.get('/admin/orders', ...admin, asyncRoute(async (req, res) => {
  const orders = await listDocs(COLLECTIONS.orders, { filters: [['shop_id', '==', req.user.shopId]], orderBy: ['created_at', 'desc'] });
  const search = String(req.query.q || '').slice(0, 100).toLocaleLowerCase();
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`).getTime() : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999`).getTime() : null;
  const enriched = await Promise.all(orders.map(enrichOrder));
  res.json(enriched.filter((order) => (!req.query.status || order.order_status === String(req.query.status)) &&
    (from === null || new Date(order.created_at).getTime() >= from) && (to === null || new Date(order.created_at).getTime() <= to) &&
    (!search || String(order.order_code || '').toLocaleLowerCase().includes(search) || String(order.original_name || '').toLocaleLowerCase().includes(search))).slice(0, 200));
}));
router.delete('/admin/orders/:orderId', ...admin, asyncRoute(async (req, res) => {
  const shopId = req.user.shopId;
  const storedNames = new Set();
  let filesCleanupWarning = false;
  const db = getDb(); const orderRef = db.collection(COLLECTIONS.orders).doc(String(req.params.orderId));
  try {
    const result = await db.runTransaction(async (transaction) => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists || orderSnapshot.data().shop_id !== shopId) return { missing: true };
      const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
      const jobRef = db.collection(COLLECTIONS.printJobs).doc(order.id);
      const jobSnapshot = await transaction.get(jobRef);
      if (order.order_status === 'printing' || ['claimed', 'printing'].includes(order.print_status) || jobSnapshot.exists && ['claimed', 'printing'].includes(jobSnapshot.data().status)) {
        throw Object.assign(new Error('An order that is currently printing cannot be deleted'), { status: 409 });
      }
      const uploadIds = [...new Set([order.upload_id, ...(order.upload_ids || [])].filter(Boolean))];
      const uploadRefs = uploadIds.map((id) => db.collection(COLLECTIONS.uploads).doc(String(id)));
      const claimRefs = uploadIds.map((id) => db.collection(COLLECTIONS.uploadOrderClaims).doc(String(id)));
      const paymentRef = db.collection(COLLECTIONS.payments).doc(order.id);
      const codeRef = db.collection(COLLECTIONS.orderCodes).doc(order.order_code);
      const [uploads, claims, paymentSnapshot, codeSnapshot] = await Promise.all([
        Promise.all(uploadRefs.map((ref) => transaction.get(ref))), Promise.all(claimRefs.map((ref) => transaction.get(ref))),
        transaction.get(paymentRef), transaction.get(codeRef),
      ]);
      if (order.print_file_name) storedNames.add(order.print_file_name);
      uploads.forEach((snapshot) => { if (snapshot.exists && snapshot.data().stored_name) storedNames.add(snapshot.data().stored_name); });
      transaction.delete(orderRef);
      if (jobSnapshot.exists) transaction.delete(jobRef);
      if (paymentSnapshot.exists) transaction.delete(paymentRef);
      if (codeSnapshot.exists) transaction.delete(codeRef);
      uploads.forEach((snapshot) => { if (snapshot.exists) transaction.delete(snapshot.ref); });
      claims.forEach((snapshot) => { if (snapshot.exists && snapshot.data().order_id === order.id) transaction.delete(snapshot.ref); });
      const auditRef = db.collection(COLLECTIONS.auditLog).doc();
      transaction.create(auditRef, { shop_id: shopId, actor: req.user.email, action: 'order.deleted', details: {
        orderCode: order.order_code, orderStatus: order.order_status, printStatus: order.print_status,
        paymentMethod: order.payment_method, paymentStatus: order.payment_status, amount: order.amount,
      }, created_at: new Date().toISOString() });
      return { deleted: true };
    });
    if (result.missing) return res.status(404).json({ error: 'Order not found' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }

  for (const storedName of storedNames) {
    if (!isSafeStoredFilename(storedName)) {
      console.warn(`Skipped unsafe stored filename while deleting order ${req.params.orderId}`);
      filesCleanupWarning = true;
      continue;
    }
    try {
      await fileStorage.delete(storedName);
    } catch (error) {
      console.error(`Could not remove stored file for deleted order ${req.params.orderId}:`, error);
      filesCleanupWarning = true;
    }
  }
  res.json({ ok: true, filesCleanupWarning });
}));
router.post('/admin/orders/:orderId/cash-confirm', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'cash-confirm')));
router.post('/admin/orders/:orderId/payment-verify', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'payment-verify')));
router.post('/admin/orders/:orderId/cancel', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'cancel')));
router.post('/admin/orders/:orderId/print-failed', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'print-failed')));
router.post('/admin/orders/:orderId/retry-print', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'retry-print')));
router.post('/admin/orders/:orderId/complete', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'complete')));
router.get('/admin/analytics', ...admin, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const rows = await queryShopAnalytics(getDb(), req.user.shopId, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, rows });
}));
router.patch('/admin/settings', ...admin, asyncRoute(async (req, res) => {
  const b = req.body; const shop = await getDoc(COLLECTIONS.shops, req.user.shopId);
  if (!shop) return res.status(401).json({ error: 'Shop account no longer exists' });
  const pc = b.printConfig ? validatePrintConfig(b.printConfig) : shop.print_config;
  const pricing = b.pricing ? validatePricing(b.pricing) : shop.pricing;
  const upiId = 'upiId' in b ? normalizeUpiId(b.upiId) : shop.upi_id;
  if (upiId && !isValidUpiId(upiId)) return res.status(400).json({ error: 'Enter a valid UPI ID such as shopname@bank' });
  const upiName = 'upiName' in b ? (String(b.upiName || '').trim().slice(0, 60) || null) : shop.upi_name;
  const updated = await updateDoc(COLLECTIONS.shops, shop.id, {
    name: b.name ?? shop.name, owner_name: b.ownerName ?? shop.owner_name, phone: b.phone ?? shop.phone,
    email: b.email ?? shop.email, address: b.address ?? shop.address, city: b.city ?? shop.city,
    upi_id: upiId, upi_name: upiName, pricing, print_config: pc,
    agent_name: b.agentName ?? shop.agent_name,
  });
  await audit(shop.id, req.user.email, 'shop.settings.updated', { fields: Object.keys(b) });
  res.json({ shop: safeShop(updated) });
}));
router.post('/admin/agent/rotate', ...admin, asyncRoute(async (req, res) => {
  const value = token(); await updateDoc(COLLECTIONS.shops, req.user.shopId, { agent_token_hash: sha256(value) }); res.json({ agentToken: value });
}));
router.get('/admin/uploads/:orderId', ...admin, asyncRoute(async (req, res) => {
  const order = await getDoc(COLLECTIONS.orders, req.params.orderId);
  if (!order || order.shop_id !== req.user.shopId) return res.status(404).json({ error: 'Document not found' });
  const upload = await getDoc(COLLECTIONS.uploads, order.upload_id);
  const file = order.print_file_name || upload?.stored_name;
  if (!isSafeStoredFilename(file)) return res.status(400).json({ error: 'Document filename is invalid' });
  let bytes;
  try { bytes = await fileStorage.get(file); }
  catch (error) { if (error.code === 'ENOENT') return res.status(410).json({ error: 'This file is no longer stored on the server' }); throw error; }
  const filename = order.print_file_name ? `photo-sheet-${req.params.orderId.slice(0, 8)}.pdf` : upload?.original_name || 'document';
  return res.type(order.print_file_name ? 'application/pdf' : upload?.mime_type || 'application/octet-stream').attachment(filename).send(bytes);
}));

// Firestore transaction claims ensure two agents cannot take the same job.
router.post('/agent/:shopId/heartbeat', asyncRoute(async (req, res) => {
  const shop = await agentShop(req);
  if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' });
  const now = new Date().toISOString();
  await updateDoc(COLLECTIONS.shops, shop.id, { agent_name: String(req.body.agentName || 'Print agent').slice(0, 100), agent_last_seen: now });
  res.json({ ok: true, serverTime: now });
}));
router.get('/agent/:shopId/jobs', asyncRoute(async (req, res) => {
  const shop = await agentShop(req);
  if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' });
  if (!isActive(shop)) return res.json({ job: null, locked: true, shopStatus: statusOf(shop) });
  const db = getDb();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const claimed = await db.collection(COLLECTIONS.printJobs).where('shop_id', '==', shop.id).where('status', '==', 'claimed').limit(100).get();
  for (const candidate of claimed.docs) {
    const initial = candidate.data();
    if (!initial.claimed_at || new Date(initial.claimed_at).getTime() >= new Date(staleCutoff).getTime()) continue;
    const orderRef = db.collection(COLLECTIONS.orders).doc(String(initial.order_id));
    await db.runTransaction(async (transaction) => {
      const [jobSnapshot, orderSnapshot] = await Promise.all([transaction.get(candidate.ref), transaction.get(orderRef)]);
      if (!jobSnapshot.exists || !orderSnapshot.exists) return;
      const job = jobSnapshot.data();
      if (job.status !== 'claimed' || new Date(job.claimed_at || 0).getTime() >= new Date(staleCutoff).getTime()) return;
      const failed = Number(job.attempts || 0) >= 5;
      const updateTime = now.toISOString();
      transaction.update(candidate.ref, {
        status: failed ? 'failed' : 'queued', claimed_by: null, claimed_at: null,
        error_message: failed ? 'The print agent did not finish this job after 5 attempts' : (job.error_message || null), updated_at: updateTime,
      });
      transaction.update(orderRef, { print_status: failed ? 'failed' : 'queued', order_status: failed ? 'failed' : 'print_queued', updated_at: updateTime });
    });
  }

  const candidates = await db.collection(COLLECTIONS.printJobs)
    .where('shop_id', '==', shop.id).where('status', '==', 'queued')
    .orderBy('queue_position', 'asc').limit(100).get();
  for (const candidate of candidates.docs) {
    const job = candidate.data();
    if (Number(job.attempts || 0) >= 5) continue;
    const order = await getDoc(COLLECTIONS.orders, job.order_id);
    if (!order || order.order_status !== 'print_queued' || order.payment_status !== 'verified') continue;
    const orderRef = db.collection(COLLECTIONS.orders).doc(order.id);
    const claimedJob = await db.runTransaction(async (transaction) => {
      const [jobSnapshot, orderSnapshot] = await Promise.all([transaction.get(candidate.ref), transaction.get(orderRef)]);
      if (!jobSnapshot.exists || !orderSnapshot.exists) return null;
      const latestJob = jobSnapshot.data(); const latestOrder = orderSnapshot.data();
      if (latestJob.status !== 'queued' || Number(latestJob.attempts || 0) >= 5 || latestOrder.order_status !== 'print_queued' || latestOrder.payment_status !== 'verified') return null;
      const upload = latestOrder.upload_id ? await transaction.get(db.collection(COLLECTIONS.uploads).doc(String(latestOrder.upload_id))) : null;
      const uploadData = upload?.exists ? upload.data() : null;
      if (!uploadData) return null;
      const updateTime = new Date().toISOString();
      transaction.update(candidate.ref, { status: 'claimed', claimed_by: 'print-agent', claimed_at: updateTime, attempts: Number(latestJob.attempts || 0) + 1, updated_at: updateTime });
      transaction.update(orderRef, { print_status: 'claimed', order_status: 'printing', updated_at: updateTime });
      return {
        job_id: candidate.id, order_id: order.id, order_code: order.order_code,
        config: order.config, page_count: order.page_count,
        copies: order.config?.mode === 'photo' ? 1 : order.copies,
        amount: order.amount, stored_name: order.print_file_name || uploadData.stored_name,
        mime_type: order.print_file_name ? 'application/pdf' : uploadData.mime_type,
        byte_size: uploadData.byte_size, original_name: order.print_file_name || uploadData.original_name,
        queue_position: latestJob.queue_position,
      };
    });
    if (claimedJob) {
      claimedJob.downloadUrl = `/api/agent/${encodeURIComponent(shop.public_id)}/jobs/${encodeURIComponent(candidate.id)}/document`;
      return res.json({ job: claimedJob });
    }
  }
  return res.json({ job: null });
}));
router.get('/agent/:shopId/jobs/:jobId/document', asyncRoute(async (req, res) => {
  const shop = await agentShop(req);
  if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' });
  const job = await getDoc(COLLECTIONS.printJobs, req.params.jobId);
  if (!job || job.shop_id !== shop.id || job.claimed_by !== 'print-agent' || !['claimed', 'printing'].includes(job.status)) return res.status(404).json({ error: 'Claimed job not found' });
  const order = await getDoc(COLLECTIONS.orders, job.order_id);
  const upload = order?.upload_id ? await getDoc(COLLECTIONS.uploads, order.upload_id) : null;
  const storedName = order?.print_file_name || upload?.stored_name;
  const originalName = order?.print_file_name || upload?.original_name;
  if (!isSafeStoredFilename(storedName)) return res.status(400).json({ error: 'Document filename is invalid' });
  let bytes;
  try { bytes = await fileStorage.get(storedName); }
  catch (error) { if (error.code === 'ENOENT') return res.status(410).json({ error: 'Print file is no longer stored' }); throw error; }
  return res.type(order?.print_file_name ? 'application/pdf' : upload?.mime_type || 'application/octet-stream').attachment(originalName || 'print-file').send(bytes);
}));
router.post('/agent/:shopId/jobs/:jobId/result', asyncRoute(async (req, res) => {
  const shop = await agentShop(req);
  if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' });
  const status = req.body.status;
  if (!['completed', 'failed'].includes(status)) return res.status(400).json({ error: 'Result must be completed or failed' });
  const db = getDb(); const jobRef = db.collection(COLLECTIONS.printJobs).doc(String(req.params.jobId));
  const now = new Date().toISOString();
  const result = await db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef);
    if (!jobSnapshot.exists) return null;
    const job = jobSnapshot.data();
    if (job.shop_id !== shop.id || job.claimed_by !== 'print-agent' || job.status !== 'claimed') return null;
    const orderRef = db.collection(COLLECTIONS.orders).doc(String(job.order_id));
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return null;
    transaction.update(jobRef, { status, error_message: status === 'failed' ? String(req.body.error || 'Printer command failed').slice(0, 1000) : null, updated_at: now });
    transaction.update(orderRef, { print_status: status, order_status: status, ...(status === 'completed' ? { completed_at: now } : {}), updated_at: now });
    return true;
  });
  if (!result) return res.status(409).json({ error: 'Job lease is no longer active' });
  return res.json({ ok: true });
}));

async function transitionOrder(req, res, action) {
  const shopId = req.user.shopId; const id = req.params.orderId; const db = getDb();
  try {
    const orderRef = db.collection(COLLECTIONS.orders).doc(id);
    const updated = await db.runTransaction(async (transaction) => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists || orderSnapshot.data().shop_id !== shopId) return null;
      const order = { id: orderSnapshot.id, ...orderSnapshot.data() };
      const jobRef = db.collection(COLLECTIONS.printJobs).doc(id);
      const paymentRef = db.collection(COLLECTIONS.payments).doc(id);
      const [jobSnapshot, paymentSnapshot] = await Promise.all([transaction.get(jobRef), transaction.get(paymentRef)]);
      const now = new Date().toISOString(); let orderPatch = {}; let jobPatch = null; let paymentPatch = null;
      if (action === 'cash-confirm') {
        if (order.payment_method !== 'cash' || order.order_status !== 'cash_confirmation_pending') throw Object.assign(new Error('Cash order is not awaiting confirmation'), { status: 409 });
        await queueForPrintTransaction(transaction, order);
        orderPatch = { order_status: 'print_queued', print_status: 'queued', payment_status: 'verified', confirmed_at: now };
      } else if (action === 'payment-verify') {
        if (order.payment_method !== 'upi' || !['pending_payment', 'payment_review'].includes(order.order_status) || order.payment_status !== 'pending') throw Object.assign(new Error('UPI order is not awaiting shop verification'), { status: 409 });
        if (Boolean(req.body.verified)) {
          await queueForPrintTransaction(transaction, order);
          orderPatch = { payment_status: 'verified', order_status: 'print_queued', print_status: 'queued', confirmed_at: now };
          paymentPatch = { status: 'verified', verified_by: req.user.email };
        } else {
          orderPatch = { payment_status: 'failed', order_status: 'failed' };
          paymentPatch = { status: 'failed', verified_by: req.user.email };
        }
      } else if (action === 'cancel') {
        if (['completed', 'printing', 'cancelled'].includes(order.order_status)) throw Object.assign(new Error('This order cannot be cancelled in its current state'), { status: 409 });
        if (jobSnapshot.exists && jobSnapshot.data().status === 'queued') transaction.delete(jobRef);
        orderPatch = { print_status: 'not_ready', order_status: 'cancelled', payment_status: order.payment_status === 'pending' ? 'cancelled' : order.payment_status };
        if (paymentSnapshot.exists && paymentSnapshot.data().status === 'pending') paymentPatch = { status: 'cancelled' };
      } else if (action === 'print-failed') {
        if (order.files_deleted_at) throw Object.assign(new Error('Print files were deleted after the 10-minute retention period and cannot be retried'), { status: 409 });
        if (!['claimed', 'printing', 'failed', 'completed'].includes(order.print_status)) throw Object.assign(new Error('Only jobs that are printing, failed or completed can be marked failed'), { status: 409 });
        jobPatch = { status: 'failed', error_message: String(req.body.reason || 'Marked failed by shop admin').slice(0, 1000) };
        orderPatch = { order_status: 'failed', print_status: 'failed' };
      } else if (action === 'retry-print') {
        if (order.order_status !== 'failed' || order.payment_status !== 'verified') throw Object.assign(new Error('Only paid, failed orders can be requeued'), { status: 409 });
        await queueForPrintTransaction(transaction, order, { reset: true });
        orderPatch = { order_status: 'print_queued', print_status: 'queued' };
      } else if (action === 'complete') {
        if (order.order_status !== 'printing') throw Object.assign(new Error('Only an order that is printing can be marked complete'), { status: 409 });
        orderPatch = { order_status: 'completed', print_status: 'completed', completed_at: now };
        jobPatch = { status: 'completed' };
      }
      transaction.update(orderRef, { ...orderPatch, updated_at: now });
      if (jobPatch && jobSnapshot.exists) transaction.update(jobRef, { ...jobPatch, updated_at: now });
      if (paymentPatch) transaction.set(paymentRef, { ...paymentPatch, updated_at: now }, { merge: true });
      const auditRef = db.collection(COLLECTIONS.auditLog).doc();
      transaction.create(auditRef, { shop_id: shopId, actor: req.user.email, action: `order.${action}`, details: { orderCode: order.order_code }, created_at: now });
      return { ...order, ...orderPatch, updated_at: now };
    });
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order: updated });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
}
const PHOTO_SIZES = {
  passport: { label: 'Passport 3.5 × 4.5 cm', w: 3.5, h: 4.5 },
  stamp: { label: 'Stamp 2 × 2.5 cm', w: 2, h: 2.5 },
  square2: { label: '2 × 2 in (5.1 × 5.1 cm)', w: 5.08, h: 5.08 },
  wallet: { label: 'Wallet 5 × 7.5 cm', w: 5, h: 7.5 },
  '4x6': { label: '4 × 6 in', w: 10.16, h: 15.24 },
  '5x7': { label: '5 × 7 in', w: 12.7, h: 17.78 },
};
const PAPER_CM = { A4: [21, 29.7], A3: [29.7, 42] };
const PHOTO_MARGIN_CM = 1, PHOTO_GAP_CM = 0.2;

// Grid of photo cells on one sheet. If turning every photo 90 degrees fits more of them, the layout does that.
function photoGeometry(size, paper, orientation) {
  const dims = PHOTO_SIZES[size];
  if (!dims) throw Object.assign(new Error('Select a supported photo size'), { status: 400 });
  const sheet = PAPER_CM[paper] || PAPER_CM.A4;
  const [sw, sh] = orientation === 'landscape' ? [sheet[1], sheet[0]] : sheet;
  const usableW = sw - 2 * PHOTO_MARGIN_CM, usableH = sh - 2 * PHOTO_MARGIN_CM;
  const fit = (cw, ch) => ({ columns: Math.max(0, Math.floor((usableW + PHOTO_GAP_CM) / (cw + PHOTO_GAP_CM))), rows: Math.max(0, Math.floor((usableH + PHOTO_GAP_CM) / (ch + PHOTO_GAP_CM))) });
  const upright = fit(dims.w, dims.h), turned = fit(dims.h, dims.w);
  const useTurned = turned.columns * turned.rows > upright.columns * upright.rows;
  const grid = useTurned ? turned : upright;
  if (grid.columns * grid.rows < 1) throw Object.assign(new Error('This photo size does not fit on the selected paper'), { status: 400 });
  return { capacity: grid.columns * grid.rows, columns: grid.columns, rows: grid.rows, widthCm: dims.w, heightCm: dims.h, rotated: useTurned, cellWidthCm: useTurned ? dims.h : dims.w, cellHeightCm: useTurned ? dims.w : dims.h, sheetCm: [sw, sh], marginCm: PHOTO_MARGIN_CM, gapCm: PHOTO_GAP_CM };
}
function photoCapacity(size, paper, orientation) { return photoGeometry(size, paper, orientation).capacity; }

// The customer's photo edits are applied in the browser and the edited image is what gets uploaded and printed.
// This only records which adjustments were made, so the shop can see that a file was edited. Never used for pricing or printing.
const EDIT_LIMITS = { brightness: [-100, 100], contrast: [-100, 100], saturation: [-100, 100], exposure: [-100, 100], highlights: [-100, 100], shadows: [-100, 100], sharpness: [0, 100], zoom: [1, 4] };
function summarizeEdit(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [key, [lo, hi]] of Object.entries(EDIT_LIMITS)) { const n = Number(input[key]); if (Number.isFinite(n) && n !== (key === 'zoom' ? 1 : 0)) out[key] = Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)); }
  if (input.bw === true) out.bw = true;
  const rotate = ((Math.round(Number(input.rotate) / 90) * 90) % 360 + 360) % 360; if (rotate) out.rotate = rotate;
  if (Number(input.panX) || Number(input.panY)) out.pan = true;
  return Object.keys(out).length ? out : null;
}

function validatePrintOptions(value, shop, file) {
  const c = { ...value };
  const pc = json(shop.print_config);
  c.mode = c.mode === 'photo' && pc.photo && file.mime_type !== 'application/pdf' ? 'photo' : 'document';
  c.paperSize = String(c.paperSize || pc.defaultPaper || 'A4').toUpperCase();
  if (!pc.paperSizes.includes(c.paperSize)) throw Object.assign(new Error('Selected paper size is not available at this shop'), { status: 400 });
  c.paperType = String(c.paperType || 'normal');
  if (!pc.paperTypes.includes(c.paperType)) throw Object.assign(new Error('Selected paper type is not available at this shop'), { status: 400 });
  c.orientation = ['portrait', 'landscape'].includes(c.orientation) ? c.orientation : 'portrait';
  c.scaling = ['fit', 'actual', 'fill'].includes(c.scaling) ? c.scaling : 'fit';
  c.color = Boolean(c.color) && Boolean(pc.color);
  c.duplex = Boolean(c.duplex) && Boolean(pc.duplex) && c.paperType === 'normal';
  c.pageRange = String(c.pageRange || 'all').trim().slice(0, 100) || 'all';
  if (file.mime_type !== 'application/pdf') c.pageRange = 'all';
  if (c.mode === 'photo') {
    if (c.paperType !== 'glossy') throw Object.assign(new Error('Photo mode requires glossy paper'), { status: 400 });
    c.photoSize = String(c.photoSize || 'passport');
    c.photoFit = c.photoFit === 'contain' ? 'contain' : 'cover';
    c.photoCapacity = photoCapacity(c.photoSize, c.paperSize, c.orientation);
    c.photoQuantity = Number(c.photoQuantity || 1); // replaced by the sum of photo items when several photos are supplied
    c.copies = 1; c.duplex = false; c.color = true;
  } else {
    c.imageEdit = file.mime_type !== 'application/pdf' ? summarizeEdit(c.imageEdit) : null;
    c.copies = Number(c.copies || 1);
    if (!Number.isInteger(c.copies) || c.copies < 1 || c.copies > 500) throw Object.assign(new Error('Copies must be between 1 and 500'), { status: 400 });
    c.photoQuantity = 0; c.photoSheets = 0;
  }
  delete c.photoItems; if (c.mode === 'photo') delete c.imageEdit;
  return c;
}

// Strict page-range parser shared by quote and order: "all", "3", "1-3,5", "2-4,7-9". Returns the number of selected pages.
function pageCount(config, total) {
  if (config.pageRange === 'all') return total;
  const nums = new Set();
  for (const raw of config.pageRange.split(',')) {
    const m = raw.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!m) throw Object.assign(new Error('Enter pages like 1-3,5 or all'), { status: 400 });
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a < 1 || b < a || b > total) throw Object.assign(new Error(`Pages must be between 1 and ${total}`), { status: 400 });
    for (let n = a; n <= b; n++) nums.add(n);
  }
  return nums.size;
}

// Resolves everything a quote or an order needs from the browser's request, always using the shop's own data and the stored upload.
async function prepareOrder(shop, body, { forQuote = false } = {}) {
  const documentTokens = body.documentTokens === undefined ? [body.uploadToken] : body.documentTokens;
  if (!Array.isArray(documentTokens) || documentTokens.length < 1 || documentTokens.length > MAX_DOCUMENT_BUNDLE_FILES ||
    documentTokens.some((item) => typeof item !== 'string' || !item.trim()) ||
    new Set(documentTokens).size !== documentTokens.length || documentTokens[0] !== body.uploadToken) {
    throw Object.assign(new Error(`Choose 1 to ${MAX_DOCUMENT_BUNDLE_FILES} different uploaded documents and keep the first upload selected`), { status: 400 });
  }
  if (documentTokens.length > 1 && body.config?.mode === 'photo') {
    throw Object.assign(new Error('Use Photo sheet mode for multiple photos, or Document mode for a file bundle'), { status: 400 });
  }
  if (documentTokens.length > 1 && body.config?.pageRange && body.config.pageRange !== 'all') {
    throw Object.assign(new Error('A document bundle prints all pages. Upload a single PDF to select a page range.'), { status: 400 });
  }
  const uploadedFiles = (await Promise.all(documentTokens.map((uploadToken) => findOne(COLLECTIONS.uploads, 'public_token', uploadToken))))
    .filter((item) => item && item.shop_id === shop.id && !item.cleanup_pending && new Date(item.expires_at).getTime() > Date.now());
  const filesByToken = new Map(uploadedFiles.map((item) => [item.public_token, item]));
  const documents = documentTokens.map((uploadToken) => filesByToken.get(uploadToken)).filter(Boolean);
  if (documents.length !== documentTokens.length) {
    throw Object.assign(new Error('One or more uploads expired or do not belong to this shop. Upload them again.'), { status: 400 });
  }
  if (documents.length > 1 && documents.reduce((total, item) => total + Number(item.byte_size), 0) > MAX_DOCUMENT_BUNDLE_BYTES) {
    throw Object.assign(new Error('The combined documents exceed the 100 MB order limit'), { status: 400 });
  }
  const file = documents[0];
  const config = validatePrintOptions(body.config, shop, file);
  let items = [{ upload: file, quantity: config.photoQuantity }];
  if (config.mode === 'photo') {
    const requested = Array.isArray(body.config?.photoItems) && body.config.photoItems.length ? body.config.photoItems : [{ uploadToken: body.uploadToken, quantity: config.photoQuantity }];
    if (requested.length > 12) throw Object.assign(new Error('A photo sheet can combine up to 12 different photos'), { status: 400 });
    if (String(requested[0].uploadToken) !== String(body.uploadToken)) throw Object.assign(new Error('Photo list is out of date. Reload and try again.'), { status: 400 });
    items = [];
    for (const item of requested) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw Object.assign(new Error('Each photo quantity must be between 1 and 500'), { status: 400 });
      const upload = String(item.uploadToken) === String(body.uploadToken) ? file : await findOne(COLLECTIONS.uploads, 'public_token', String(item.uploadToken || ''));
      if (!upload || upload.shop_id !== shop.id || upload.cleanup_pending || new Date(upload.expires_at).getTime() <= Date.now() || upload.mime_type === 'application/pdf') throw Object.assign(new Error('One of the photos has expired. Upload it again.'), { status: 400 });
      if (items.some((x) => x.upload.id === upload.id)) throw Object.assign(new Error('The same photo was added twice. Change its quantity instead.'), { status: 400 });
      items.push({ upload, quantity });
    }
    config.photoQuantity = items.reduce((sum, x) => sum + x.quantity, 0);
    if (config.photoQuantity > 500) throw Object.assign(new Error('Total photos must not exceed 500'), { status: 400 });
    config.photoSheets = Math.ceil(config.photoQuantity / config.photoCapacity);
    config.copies = config.photoSheets;
    config.photoLayout = items.map((x, i) => ({ name: x.upload.original_name, quantity: x.quantity, edit: summarizeEdit(requested[i]?.edit) }));
  } else if (documents.length > 1) {
    items = documents.map((upload) => ({ upload, quantity: 1 }));
    config.pageRange = 'all';
    config.imageEdit = null;
    config.documentFiles = documents.map((item) => item.original_name);
  }
  const pages = config.mode === 'photo' ? 1 : documents.length > 1 ? documents.reduce((sum, item) => sum + Number(item.page_count), 0) : pageCount(config, file.page_count);
  if (pages > 2000) throw Object.assign(new Error('A combined order cannot exceed 2000 printable pages'), { status: 400 });
  let quote;
  try { quote = calculatePrice({ pricing: json(shop.pricing), pages, copies: config.copies, color: config.color, paperSize: config.paperSize, paperType: config.paperType, duplex: config.duplex, photoSheets: config.photoSheets }); }
  catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
  if (!(quote.total > 0)) throw Object.assign(new Error('This shop has not set a price for this combination yet. Ask the shop or choose other options.'), { status: 400 });
  return { file, items, config, pages, quote, forQuote };
}

function createPhotoPrintFile(items, config) {
  return new Promise((resolve, reject) => {
    const cm = 72 / 2.54, g = photoGeometry(config.photoSize, config.paperSize, config.orientation);
    const margin = g.marginCm * cm, gap = g.gapCm * cm;
    const photoW = g.widthCm * cm, photoH = g.heightCm * cm, cellW = g.cellWidthCm * cm, cellH = g.cellHeightCm * cm;
    const pageOptions = { size: config.paperSize, layout: config.orientation, margins: { top: 0, right: 0, bottom: 0, left: 0 } };
    const doc = new PDFDocument({ ...pageOptions, compress: true }); const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    (async () => {
    try {
      let index = 0;
      for (const item of items) {
        if (!isSafeStoredFilename(item.upload.stored_name)) throw new Error('Uploaded image has an invalid stored filename');
        const imageBytes = await fileStorage.get(item.upload.stored_name);
        for (let n = 0; n < item.quantity; n++, index++) {
          const page = Math.floor(index / g.capacity);
          if (page > 0 && index % g.capacity === 0) doc.addPage(pageOptions);
          const slot = index % g.capacity, col = slot % g.columns, row = Math.floor(slot / g.columns);
          const x = margin + col * (cellW + gap), y = margin + row * (cellH + gap);
          const box = config.photoFit === 'contain' ? { fit: [photoW, photoH] } : { cover: [photoW, photoH] };
          doc.save();
          if (g.rotated) { doc.translate(x + cellW, y); doc.rotate(90); doc.image(imageBytes, 0, 0, { ...box, align: 'center', valign: 'center' }); }
          else doc.image(imageBytes, x, y, { ...box, align: 'center', valign: 'center' });
          doc.restore();
          doc.rect(x, y, cellW, cellH).lineWidth(0.4).strokeColor('#8a8f8a').stroke(); // hairline cut guide
        }
      }
      doc.end();
    } catch (error) { doc.destroy(error); reject(error); }
    })();
  });
}

// Reads pixel dimensions from PNG/JPEG headers so absurd images are rejected before they reach the PDF renderer.
function imageSize(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

function detectMime(bytes) { if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf'; if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'; if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'; return 'unknown'; }
function safeEqual(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

module.exports = router;
