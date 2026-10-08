const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { createDocumentBundle } = require('../services/documentBundle');
const { pool } = require('../db');
const { issue, authenticate, role } = require('../middleware/auth');
const { OPTIONAL_PRICING_KEYS, DEFAULT_PRICING, DEFAULT_PRINT_CONFIG, isActive, statusOf, calculatePrice, publicId, orderCode, token, sha256 } = require('../services/core');
const { audit } = require('../services/audit');
const { isValidUpiId, normalizeUpiId, buildUpiUri, upiQr } = require('../services/upi');
const { webhookEnabled, verifySignature } = require('../services/webhook');
const { baseUrl } = require('../services/network');
const { parseAnalyticsRange, queryPlatformAnalytics, queryShopAnalytics } = require('../services/reports');
const { hasPersistentUploadDirectory, isSafeStoredFilename } = require('../services/storagePolicy');

const router = express.Router();
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage');
const MAX_DOCUMENT_BUNDLE_FILES = 10;
const MAX_DOCUMENT_BUNDLE_BYTES = 100 * 1024 * 1024;
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: uploadDir, filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 30) * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Upload a PDF, JPG, or PNG file')),
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = authenticate;
const ensureActiveShop = asyncRoute(async (req, res, next) => {
  const { rows } = await pool.query('SELECT * FROM shops WHERE id=$1', [req.user.shopId]);
  if (!rows[0]) { res.clearCookie('session', { path: '/' }); return res.status(401).json({ error: 'Shop account no longer exists. Please sign in again.' }); }
  if (req.user.pv !== sessionStamp(rows[0])) { res.clearCookie('session', { path: '/' }); return res.status(401).json({ error: 'Your login details changed. Please sign in again.' }); }
  if (!isActive(rows[0])) return res.status(423).json({ error: `Shop access is ${statusOf(rows[0])}` });
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
async function findShop(publicIdValue) { const { rows } = await pool.query('SELECT * FROM shops WHERE public_id=$1', [String(publicIdValue || '').toUpperCase()]); return rows[0]; }
const sessionStamp = (shop) => sha256(`${shop.admin_password_hash}|${shop.admin_email}`).slice(0, 16);
function checkShopAdmin(req, res, next) { if (req.user.shopId !== req.params.shopId) return res.status(404).json({ error: 'Shop not found' }); next(); }
function apiShop(req, res, next) { if (req.user.shopPublicId !== req.params.shopId) return res.status(404).json({ error: 'Shop not found' }); next(); }
async function agentShop(req) {
  const supplied = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!supplied) return null;
  const { rows } = await pool.query('SELECT * FROM shops WHERE public_id=$1 AND agent_token_hash=$2', [req.params.shopId, sha256(supplied)]);
  return rows[0] || null;
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

router.get('/health', asyncRoute(async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }));
router.get('/meta', (_req, res) => res.json({ maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 30) }));
router.get('/session', asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ user: null });
  if (req.user.role === 'super_admin') return res.json({ user: { role: 'super_admin', email: req.user.email } });
  if (req.user.role !== 'shop_admin') return res.json({ user: null });
  const { rows } = await pool.query('SELECT public_id,name FROM shops WHERE id=$1', [req.user.shopId]);
  if (!rows[0]) { res.clearCookie('session', { path: '/' }); return res.json({ user: null }); }
  res.json({ user: { role: 'shop_admin', shopId: rows[0].public_id, email: req.user.email, shopName: rows[0].name } });
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
  const { rows } = await pool.query('SELECT * FROM shops WHERE lower(admin_email)=lower($1)', [email]);
  const shop = rows[0];
  if (!shop || !(await bcrypt.compare(String(req.body.password || ''), shop.admin_password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
  if (!isActive(shop)) return res.status(423).json({ error: `This shop is ${statusOf(shop)}. Contact the platform administrator.` });
  issue(res, { role: 'shop_admin', shopId: shop.id, shopPublicId: shop.public_id, email, pv: sessionStamp(shop) }); res.json({ user: { role: 'shop_admin', shopId: shop.public_id, email, shopName: shop.name } });
}));
router.post('/auth/logout', (_req, res) => { res.clearCookie('session', { path: '/' }); res.json({ ok: true }); });

// Platform owner endpoints
router.get('/super/overview', ...owner, asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`SELECT count(*)::int total,
    count(*) FILTER (WHERE NOT manually_locked AND access_end>now())::int active,
    count(*) FILTER (WHERE manually_locked)::int locked,
    count(*) FILTER (WHERE NOT manually_locked AND access_end<=now())::int expired,
    count(*) FILTER (WHERE NOT manually_locked AND access_end>now() AND access_end<=now()+interval '7 days')::int expiring
    FROM shops`);
  const { rows: orders } = await pool.query(`SELECT count(*)::int total,
    count(*) FILTER (WHERE created_at::date=current_date)::int today,
    coalesce(sum((config->>'billablePages')::int),0)::int pages,
    coalesce(sum(amount) FILTER (WHERE payment_method='upi' AND payment_status='verified'),0)::numeric(12,2) verified_revenue
    FROM orders`);
  const { rows: recent } = await pool.query(`SELECT o.order_code,o.amount,o.order_status,o.created_at,s.name shop_name FROM orders o JOIN shops s ON s.id=o.shop_id ORDER BY o.created_at DESC LIMIT 8`);
  res.json({ shops: rows[0], orders: orders[0], recent });
}));
router.get('/super/analytics', ...owner, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const shops = await queryPlatformAnalytics(pool, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, shops });
}));
router.get('/admin/analytics', ...admin, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const rows = await queryShopAnalytics(pool, req.user.shopId, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, rows });
}));
router.get('/super/analytics', ...owner, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const shops = await queryPlatformAnalytics(pool, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, shops });
}));
router.get('/super/shops', ...owner, asyncRoute(async (req, res) => {
  const search = `%${String(req.query.q || '').trim()}%`;
  const { rows } = await pool.query(`SELECT * FROM shops WHERE ($1='%%' OR name ILIKE $1 OR owner_name ILIKE $1 OR public_id ILIKE $1 OR city ILIKE $1) ORDER BY created_at DESC`, [search]);
  res.json(rows.map(safeShop));
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO shops(public_id,name,owner_name,phone,email,address,city,admin_email,admin_password_hash,pricing,print_config,upi_id,upi_name,access_start,access_end,agent_token_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now()+($14||' days')::interval,$15) RETURNING *`,
      [id, String(b.name).trim(), String(b.ownerName).trim(), String(b.phone).trim(), b.email || null, String(b.address).trim(), String(b.city).trim(), String(b.adminEmail).trim().toLowerCase(), passwordHash, pricing, printConfig, upiId, String(b.upiName || '').trim().slice(0, 60) || null, String(days), sha256(agentToken)]);
    await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [rows[0].id, req.user.email, 'shop.created', { publicId: id }]);
    await client.query('COMMIT');
    const customerUrl = `${baseUrl(req)}/shop/${encodeURIComponent(id)}`;
    const qr = await QRCode.toDataURL(customerUrl, { errorCorrectionLevel: 'H', margin: 2, width: 480 });
    res.status(201).json({ shop: safeShop(rows[0]), customerUrl, qr, agentToken });
  } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') return res.status(409).json({ error: 'A shop already uses that admin email' }); throw error; }
  finally { client.release(); }
}));
router.get('/super/shops/:shopId', ...owner, asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const { rows: stats } = await pool.query(`SELECT count(*)::int orders,
    count(*) FILTER(WHERE created_at::date=current_date)::int today,
    count(*) FILTER(WHERE created_at>=date_trunc('month',now()))::int month_orders,
    count(*) FILTER(WHERE created_at>=date_trunc('year',now()))::int year_orders,
    coalesce(sum((config->>'billablePages')::int),0)::int pages,
    coalesce(sum(amount),0)::numeric(12,2) charges,
    coalesce(sum(amount) FILTER(WHERE payment_status='verified'),0)::numeric(12,2) online_verified,
    coalesce(sum(amount) FILTER(WHERE payment_method='cash' AND order_status IN ('print_queued','printing','completed')),0)::numeric(12,2) cash_confirmed
    FROM orders WHERE shop_id=$1`, [shop.id]);
  const { rows: recent } = await pool.query('SELECT * FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 12', [shop.id]);
  const customerUrl = `${baseUrl(req)}/shop/${encodeURIComponent(shop.public_id)}`;
  res.json({ shop: safeShop(shop), stats: stats[0], recent, customerUrl, qr: await QRCode.toDataURL(customerUrl, { errorCorrectionLevel: 'H', margin: 2, width: 480 }) });
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
  let rows;
  try {
    ({ rows } = await pool.query(`UPDATE shops SET name=$2,owner_name=$3,phone=$4,email=$5,address=$6,city=$7,admin_email=$8,
    admin_password_hash=$9,pricing=$10,print_config=$11,upi_id=$12,upi_name=$13 WHERE id=$1 RETURNING *`,
      [shop.id, b.name ?? shop.name, b.ownerName ?? shop.owner_name, b.phone ?? shop.phone, b.email ?? shop.email, b.address ?? shop.address, b.city ?? shop.city, b.adminEmail ? String(b.adminEmail).toLowerCase() : shop.admin_email, passwordHash, pricing, printConfig, upiId, 'upiName' in b ? (String(b.upiName || '').trim().slice(0, 60) || null) : shop.upi_name]));
  }
  catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Another shop already uses that admin email' }); throw e; }
  await audit(shop.id, req.user.email, 'shop.updated', { fields: Object.keys(b).filter(k => k !== 'adminPassword') }); res.json({ shop: safeShop(rows[0]) });
}));
router.post('/super/shops/:shopId/lock', ...owner, asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const locked = Boolean(req.body.locked); await pool.query('UPDATE shops SET manually_locked=$2 WHERE id=$1', [shop.id, locked]);
  await audit(shop.id, req.user.email, locked ? 'shop.locked' : 'shop.unlocked'); res.json({ status: locked ? 'locked' : statusOf({ ...shop, manually_locked: false }) });
}));
router.post('/super/shops/:shopId/extend', ...owner, asyncRoute(async (req, res) => {
  const days = Number(req.body.days || 30); if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Extension must be between 1 and 3650 days' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); const { rows } = await client.query('SELECT * FROM shops WHERE public_id=$1 FOR UPDATE', [req.params.shopId]);
    const shop = rows[0]; if (!shop) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Shop not found' }); }
    const { rows: updated } = await client.query(`UPDATE shops SET access_end=greatest(access_end,now())+($2||' days')::interval,manually_locked=false WHERE id=$1 RETURNING *`, [shop.id, String(days)]);
    await client.query('INSERT INTO access_extensions(shop_id,days,previous_expiry,new_expiry,actor) VALUES($1,$2,$3,$4,$5)', [shop.id, days, shop.access_end, updated[0].access_end, req.user.email]);
    await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [shop.id, req.user.email, 'shop.extended', { days, expiresAt: updated[0].access_end }]); await client.query('COMMIT'); res.json({ shop: safeShop(updated[0]) });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
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
  const { rows } = await pool.query('SELECT o.*, row_to_json(s) AS shop_row FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.order_code=$1', [String(code || '').toUpperCase()]);
  if (!rows[0]) return null;
  const { shop_row: shop, ...order } = rows[0];
  return { order, shop };
}

router.get('/shops/:shopId/public', asyncRoute(async (req, res) => {
  const shop = await findShop(req.params.shopId); if (!shop) return res.status(404).json({ error: 'This shop portal does not exist' });
  if (!isActive(shop)) return res.status(423).json({ error: `${shop.name} is currently ${statusOf(shop)} and cannot accept orders`, status: statusOf(shop) });
  res.json({ shop: publicShopView(shop) });
}));
router.post('/shops/:shopId/uploads', (req, res, next) => {
  if (!hasPersistentUploadDirectory()) return res.status(503).json({ error: 'Persistent upload storage is not configured. Set UPLOAD_DIR to the mounted disk path.' });
  return next();
}, upload.single('document'), asyncRoute(async (req, res) => {
  const drop = () => { if (req.file) fs.rmSync(req.file.path, { force: true }); };
  const shop = await findShop(req.params.shopId); if (!shop) { drop(); return res.status(404).json({ error: 'Shop portal not found' }); }
  if (!isActive(shop)) { drop(); return res.status(423).json({ error: `Shop is ${statusOf(shop)}` }); }
  if (!req.file) return res.status(400).json({ error: 'Choose a document to upload' });
  const bytes = fs.readFileSync(req.file.path); const mime = detectMime(bytes);
  if (mime !== req.file.mimetype) { drop(); return res.status(400).json({ error: 'The file contents do not match the selected file type' }); }
  let pages = 1, width = null, height = null;
  if (mime === 'application/pdf') {
    try { const parsed = await pdfParse(Uint8Array.from(bytes)); pages = parsed.numpages; if (!Number.isInteger(pages) || pages < 1 || pages > 2000) throw new Error('PDF must contain 1 to 2000 pages'); }
    catch (e) { console.error('PDF analysis rejected an upload:', e.message); drop(); return res.status(400).json({ error: e.message.includes('PDF must contain') ? e.message : 'Could not read this PDF. It may be damaged or password protected. Export or save it again and retry.' }); }
  } else {
    const size = imageSize(bytes);
    if (!size || size.width < 1 || size.height < 1) { drop(); return res.status(400).json({ error: 'Could not read this image. Try saving it again as JPG or PNG.' }); }
    if (size.width > 12000 || size.height > 12000 || size.width * size.height > 100e6) { drop(); return res.status(400).json({ error: 'This image is too large to print. Reduce it to under 12000 pixels on each side.' }); }
    ({ width, height } = size);
  }
  const publicToken = token();
  try {
    const { rows } = await pool.query(`INSERT INTO uploads(public_token,shop_id,original_name,stored_name,mime_type,byte_size,page_count,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 hours') RETURNING id,page_count,byte_size`,
      [publicToken, shop.id, path.basename(req.file.originalname).slice(0, 200), path.basename(req.file.filename), mime, req.file.size, pages]);
    res.status(201).json({ uploadToken: publicToken, fileName: path.basename(req.file.originalname), mimeType: mime, size: rows[0].byte_size, pages: rows[0].page_count, width, height });
  } catch (e) { drop(); throw e; }
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
  const { rows: existing } = await pool.query(`SELECT o.* FROM orders o JOIN uploads u ON u.id=o.upload_id WHERE u.public_token=$1 AND o.shop_id=$2`, [String(b.uploadToken || ''), shop.id]);
  if (existing[0]) return res.status(200).json({ order: await orderView(existing[0], shop, { withQr: true }), resumed: true });
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
  if (printFileName) {
    try {
      const outputPath = path.join(uploadDir, printFileName);
      if (documentBundle) await createDocumentBundle(items, outputPath, config, uploadDir);
      else await createPhotoPrintFile(items, outputPath, config);
    } catch (e) {
      console.error('Printable PDF preparation failed:', e.message);
      fs.rmSync(path.join(uploadDir, printFileName), { force: true });
      return res.status(400).json({ error: documentBundle ? 'Could not combine these files into one print document.' : 'Could not prepare these photos for a photo sheet. Try different JPG or PNG files.' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (items.length > 1) { const { rows: taken } = await client.query('SELECT 1 FROM order_uploads WHERE upload_id = ANY($1) UNION SELECT 1 FROM orders WHERE upload_id = ANY($1)', [items.map((x) => x.upload.id)]); if (taken.length) throw Object.assign(new Error('One of these uploads is already part of another order. Upload the files again.'), { status: 409 }); }
    const { rows } = await client.query(`INSERT INTO orders(order_code,shop_id,upload_id,print_file_name,customer_name,customer_phone,config,page_count,copies,amount,payment_method,payment_status,order_status,print_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,'not_ready') RETURNING *`,
      [code, shop.id, file.id, printFileName, String(b.customerName || '').slice(0, 100) || null, String(b.customerPhone || '').slice(0, 40) || null,
        { ...config, sourcePageCount: pages, printPageCount: config.mode === 'photo' ? config.photoSheets : pages, fileName: config.mode === 'photo' ? `${items.length} photos` : documentBundle ? `${items.length} files` : file.original_name, documentFiles: documentBundle ? items.map((item) => item.upload.original_name) : undefined, billablePages: quote.printablePages * config.copies, priceBreakdown: quote },
        pages, config.copies, quote.total, b.paymentMethod, orderStatus]);
    if (config.mode === 'photo' || documentBundle) for (const [i, item] of items.entries()) await client.query('INSERT INTO order_uploads(order_id,upload_id,quantity,position) VALUES($1,$2,$3,$4)', [rows[0].id, item.upload.id, item.quantity, i]);
    if (b.paymentMethod === 'upi') await client.query('INSERT INTO payments(order_id,shop_id,amount) VALUES($1,$2,$3)', [rows[0].id, shop.id, quote.total]);
    await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [shop.id, 'customer', 'order.created', { orderCode: code, paymentMethod: b.paymentMethod, amount: quote.total }]);
    await client.query('COMMIT');
    res.status(201).json({ order: await orderView(rows[0], shop, { withQr: true }) });
  } catch (e) {
    await client.query('ROLLBACK'); if (printFileName) fs.rmSync(path.join(uploadDir, printFileName), { force: true });
    if (e.code === '23505') { const { rows: again } = await pool.query(`SELECT o.* FROM orders o JOIN uploads u ON u.id=o.upload_id WHERE u.public_token=$1 AND o.shop_id=$2`, [String(b.uploadToken || ''), shop.id]); if (again[0]) return res.status(200).json({ order: await orderView(again[0], shop, { withQr: true }), resumed: true }); return res.status(409).json({ error: 'This upload already has an order. Upload the file again to start another order.' }); }
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally { client.release(); }
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
  if (['print_queued', 'printing'].includes(order.order_status)) ahead = (await pool.query(`SELECT count(*)::int n FROM print_jobs j WHERE j.shop_id=$1 AND j.status IN ('queued','claimed','printing') AND j.queue_position < (SELECT queue_position FROM print_jobs WHERE order_id=$2)`, [order.shop_id, order.id])).rows[0].n;
  res.json({ order_code: order.order_code, order_status: order.order_status, payment_status: order.payment_status, print_status: order.print_status, payment_method: order.payment_method, reference_received: order.payment_reference !== null, payment_claimed: order.payment_claimed_at !== null, amount: Number(order.amount), printer_online: agentOnline(shop), ahead, updated_at: order.updated_at });
}));

async function customerOrderAction(req, res, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT o.*, s.upi_id, s.upi_name, s.name shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.order_code=$1 FOR UPDATE OF o', [String(req.params.code || '').toUpperCase()]);
    const order = rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    const fail = (status, error) => { throw Object.assign(new Error(error), { status }); };
    const upiUnpaid = order.payment_method === 'upi' && order.payment_status === 'pending';
    if (action === 'claim') {
      const reference = String(req.body?.reference || '').trim().toUpperCase();
      if (reference && !/^[A-Z0-9]{6,30}$/.test(reference)) fail(400, 'A UPI transaction reference has 6 to 30 letters and numbers. Leave it blank if you do not have it.');
      if (req.requireReference && !reference) fail(400, 'Enter your UPI transaction reference');
      if (!upiUnpaid) fail(409, order.payment_method === 'upi' ? 'This payment is already processed' : 'This is not a UPI order');
      if (order.order_status === 'payment_review' && (!reference || order.payment_reference === reference)) { await client.query('COMMIT'); return res.json({ ok: true, message: 'The shop has been notified and will verify your payment.' }); }
      if (order.order_status === 'payment_review' && order.payment_reference && order.payment_reference !== reference) fail(409, 'A transaction reference was already submitted for this order. Contact the shop if it needs correction.');
      if (!['pending_payment', 'payment_review'].includes(order.order_status)) fail(409, 'This order can no longer accept payment');
      await client.query(`UPDATE orders SET order_status='payment_review', payment_claimed_at=COALESCE(payment_claimed_at, now()), payment_reference=COALESCE($2, payment_reference) WHERE id=$1`, [order.id, reference || null]);
      if (reference) await client.query('UPDATE payments SET reference=$2 WHERE order_id=$1', [order.id, reference]);
      await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'customer', 'payment.claimed', { orderCode: order.order_code, hasReference: Boolean(reference) }]);
    } else if (action === 'cancel') {
      const cashPending = order.payment_method === 'cash' && order.order_status === 'cash_confirmation_pending';
      const upiNotClaimed = upiUnpaid && order.order_status === 'pending_payment';
      if (order.order_status === 'cancelled') { await client.query('COMMIT'); return res.json({ ok: true }); }
      if (!cashPending && !upiNotClaimed) fail(409, order.order_status === 'payment_review' ? 'You already told the shop you paid. Please ask the shop to cancel this order.' : 'This order can no longer be cancelled here');
      await client.query(`UPDATE orders SET order_status='cancelled', payment_status='cancelled' WHERE id=$1`, [order.id]);
      await client.query(`UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='pending'`, [order.id]);
      await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'customer', 'order.cancelled_by_customer', { orderCode: order.order_code }]);
    } else if (action === 'switch-cash') {
      if (!(upiUnpaid && order.order_status === 'pending_payment')) fail(409, order.order_status === 'payment_review' ? 'You already told the shop you paid by UPI. Ask the shop to handle this order.' : 'Payment method can no longer be changed');
      await client.query(`UPDATE orders SET payment_method='cash', order_status='cash_confirmation_pending', payment_reference=NULL, payment_claimed_at=NULL WHERE id=$1`, [order.id]);
      await client.query(`UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='pending'`, [order.id]);
      await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'customer', 'order.switched_to_cash', { orderCode: order.order_code }]);
    }
    await client.query('COMMIT');
    const found = await loadOrderWithShop(order.order_code);
    res.json({ ok: true, order: await orderView(found.order, found.shop, { withQr: true }) });
  } catch (e) { await client.query('ROLLBACK'); if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  finally { client.release(); }
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`INSERT INTO payment_events(provider,event_id,order_code,payload) VALUES('webhook',$1,$2,$3) ON CONFLICT (provider,event_id) DO NOTHING RETURNING id`, [eventId, orderCodeValue, { status: e.status, amount: e.amount, currency: e.currency, providerPaymentId }]);
    if (!inserted.rows[0]) { await client.query('ROLLBACK'); return res.json({ ok: true, duplicate: true }); }
    const setOutcome = (outcome) => client.query('UPDATE payment_events SET outcome=$2 WHERE id=$1', [inserted.rows[0].id, outcome]);
    const { rows } = await client.query('SELECT * FROM orders WHERE order_code=$1 FOR UPDATE', [orderCodeValue]);
    const order = rows[0];
    if (!order) { await setOutcome('unknown_order'); await client.query('COMMIT'); return res.status(404).json({ error: 'Unknown order' }); }
    await client.query('UPDATE payment_events SET order_id=$2 WHERE id=$1', [inserted.rows[0].id, order.id]);
    if (order.payment_method !== 'upi') { await setOutcome('not_upi'); await client.query('COMMIT'); return res.status(409).json({ error: 'Order is not a UPI order' }); }
    if (e.status === 'failed') { await client.query(`UPDATE payments SET status='failed' WHERE order_id=$1 AND status='pending'`, [order.id]); await setOutcome('provider_failed'); await client.query('COMMIT'); return res.json({ ok: true, outcome: 'provider_failed' }); }
    if (Math.round(amount * 100) !== Math.round(Number(order.amount) * 100)) {
      await setOutcome('amount_mismatch'); await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'webhook', 'payment.amount_mismatch', { orderCode: order.order_code, expected: Number(order.amount), received: e.amount }]); await client.query('COMMIT');
      return res.status(422).json({ error: 'Amount or currency does not match the order' });
    }
    if (order.payment_status === 'verified') { await setOutcome('already_verified'); await client.query('COMMIT'); return res.json({ ok: true, outcome: 'already_verified' }); }
    if (!(order.payment_status === 'pending' && UNPAID_UPI.includes(order.order_status))) {
      await setOutcome('needs_review'); await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'webhook', 'payment.needs_review', { orderCode: order.order_code, orderStatus: order.order_status }]); await client.query('COMMIT');
      return res.status(202).json({ ok: true, outcome: 'needs_review' });
    }
    await lockPrintQueue(client, order.shop_id);
    await queueForPrint(client, order);
    await client.query(`UPDATE orders SET payment_status='verified', order_status='print_queued', print_status='queued', confirmed_at=now(), payment_reference=COALESCE(payment_reference,$2) WHERE id=$1`, [order.id, providerPaymentId]);
    await client.query(`UPDATE payments SET status='verified', verified_by='webhook', reference=COALESCE($2,reference) WHERE order_id=$1`, [order.id, providerPaymentId]);
    await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [order.shop_id, 'webhook', 'payment.verified', { orderCode: order.order_code }]);
    await setOutcome('verified'); await client.query('COMMIT');
    res.json({ ok: true, outcome: 'verified' });
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}));

// Shop admin endpoints
router.get('/admin/me', ...admin, asyncRoute(async (req, res) => { const { rows } = await pool.query('SELECT * FROM shops WHERE id=$1', [req.user.shopId]); if (!rows[0]) return res.status(401).json({ error: 'Shop account no longer exists' }); if (!isActive(rows[0])) return res.status(423).json({ error: `Shop is ${statusOf(rows[0])}` }); res.json({ shop: safeShop(rows[0]) }); }));
router.get('/admin/overview', ...admin, asyncRoute(async (req, res) => { const shopId = req.user.shopId; const { rows } = await pool.query(`SELECT count(*) FILTER(WHERE created_at::date=current_date)::int today_orders,coalesce(sum((config->>'billablePages')::int) FILTER(WHERE created_at::date=current_date),0)::int today_pages,coalesce(sum(amount) FILTER(WHERE created_at::date=current_date AND order_status IN ('print_queued','printing','completed')),0)::numeric(12,2) today_earnings,count(*) FILTER(WHERE order_status='cash_confirmation_pending')::int cash_pending,count(*) FILTER(WHERE order_status='payment_review')::int payment_pending,count(*) FILTER(WHERE order_status='pending_payment')::int awaiting_payment,count(*) FILTER(WHERE print_status IN ('queued','claimed','printing'))::int queue FROM orders WHERE shop_id=$1`, [shopId]); const { rows: recent } = await pool.query('SELECT o.*,u.original_name,j.error_message print_error FROM orders o JOIN uploads u ON u.id=o.upload_id LEFT JOIN print_jobs j ON j.order_id=o.id WHERE o.shop_id=$1 ORDER BY o.created_at DESC LIMIT 12', [shopId]); const { rows: agent } = await pool.query('SELECT agent_name,agent_last_seen FROM shops WHERE id=$1', [shopId]); res.json({ stats: rows[0], recent, agent: agent[0] }); }));
router.get('/admin/print-queue', ...admin, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, u.original_name, u.mime_type, u.byte_size,
            j.error_message print_error, j.attempts print_attempts,
            j.queue_position print_queue_position
     FROM print_jobs j
     JOIN orders o ON o.id = j.order_id
     JOIN uploads u ON u.id = o.upload_id
     WHERE j.shop_id = $1 AND j.status = 'queued'
       AND o.order_status = 'print_queued' AND o.payment_status = 'verified'
     ORDER BY j.queue_position, j.created_at, j.id`,
    [req.user.shopId],
  );
  res.json(rows);
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockPrintQueue(client, req.user.shopId);
    const { rows } = await client.query(
      `SELECT o.id, o.order_code
       FROM print_jobs j
       JOIN orders o ON o.id = j.order_id
       WHERE j.shop_id = $1 AND j.status = 'queued'
         AND o.order_status = 'print_queued' AND o.payment_status = 'verified'
       ORDER BY j.queue_position, j.created_at, j.id
       FOR UPDATE OF j`,
      [req.user.shopId],
    );
    const currentIds = rows.map((row) => row.id.toLowerCase());
    const requestedIds = new Set(normalizedIds);
    if (currentIds.length !== normalizedIds.length || currentIds.some((id) => !requestedIds.has(id))) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The print queue changed. Refresh and try again.' });
    }

    await client.query(
      `UPDATE print_jobs jobs
       SET queue_position = ordered.position, updated_at = now()
       FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, position)
       WHERE jobs.order_id = ordered.id AND jobs.shop_id = $1 AND jobs.status = 'queued'`,
      [req.user.shopId, normalizedIds],
    );
    const orderCodes = new Map(rows.map((row) => [row.id.toLowerCase(), row.order_code]));
    await client.query(
      'INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)',
      [req.user.shopId, req.user.email, 'print_queue.reordered', { orderCodes: normalizedIds.map((id) => orderCodes.get(id)) }],
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));
router.get('/admin/orders', ...admin, asyncRoute(async (req, res) => { const params = [req.user.shopId]; let where = 'o.shop_id=$1'; if (req.query.status) { params.push(String(req.query.status)); where += ' AND o.order_status=$' + params.length; } if (req.query.from) { params.push(req.query.from); where += ' AND o.created_at >= $' + params.length + '::date'; } if (req.query.to) { params.push(req.query.to); where += ' AND o.created_at < ($' + params.length + '::date + interval \'1 day\')'; } if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 100)}%`); where += ' AND (o.order_code ILIKE $' + params.length + ' OR u.original_name ILIKE $' + params.length + ')'; } const { rows } = await pool.query(`SELECT o.*,u.original_name,u.mime_type,u.byte_size,j.error_message print_error,j.attempts print_attempts,j.queue_position print_queue_position FROM orders o JOIN uploads u ON u.id=o.upload_id LEFT JOIN print_jobs j ON j.order_id=o.id WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`, params); res.json(rows); }));
router.post('/admin/orders/:orderId/cash-confirm', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'cash-confirm')));
router.post('/admin/orders/:orderId/payment-verify', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'payment-verify')));
router.post('/admin/orders/:orderId/cancel', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'cancel')));
router.post('/admin/orders/:orderId/print-failed', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'print-failed')));
router.post('/admin/orders/:orderId/retry-print', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'retry-print')));
router.post('/admin/orders/:orderId/complete', ...admin, asyncRoute(async (req, res) => transitionOrder(req, res, 'complete')));
router.get('/admin/analytics', ...admin, asyncRoute(async (req, res) => {
  const range = parseAnalyticsRange(req.query);
  const rows = await queryShopAnalytics(pool, req.user.shopId, range);
  res.json({ groupBy: range.groupBy, timeZone: range.timeZone, from: range.from, to: range.to, rows });
}));
router.patch('/admin/settings', ...admin, asyncRoute(async (req, res) => { const b = req.body; const { rows } = await pool.query('SELECT * FROM shops WHERE id=$1', [req.user.shopId]); const shop = rows[0]; const pc = b.printConfig ? validatePrintConfig(b.printConfig) : shop.print_config; const pricing = b.pricing ? validatePricing(b.pricing) : shop.pricing; const upiId = 'upiId' in b ? normalizeUpiId(b.upiId) : shop.upi_id; if (upiId && !isValidUpiId(upiId)) return res.status(400).json({ error: 'Enter a valid UPI ID such as shopname@bank' }); const upiName = 'upiName' in b ? (String(b.upiName || '').trim().slice(0, 60) || null) : shop.upi_name; const { rows: updated } = await pool.query('UPDATE shops SET name=$2,owner_name=$3,phone=$4,email=$5,address=$6,city=$7,upi_id=$8,upi_name=$9,pricing=$10,print_config=$11,agent_name=$12 WHERE id=$1 RETURNING *', [shop.id, b.name ?? shop.name, b.ownerName ?? shop.owner_name, b.phone ?? shop.phone, b.email ?? shop.email, b.address ?? shop.address, b.city ?? shop.city, upiId, upiName, pricing, pc, b.agentName ?? shop.agent_name]); await audit(shop.id, req.user.email, 'shop.settings.updated', { fields: Object.keys(b) }); res.json({ shop: safeShop(updated[0]) }); }));
router.post('/admin/agent/rotate', ...admin, asyncRoute(async (req, res) => { const value = token(); await pool.query('UPDATE shops SET agent_token_hash=$2 WHERE id=$1', [req.user.shopId, sha256(value)]); res.json({ agentToken: value }); }));
router.get('/admin/uploads/:orderId', ...admin, asyncRoute(async (req, res) => { const { rows } = await pool.query(`SELECT u.stored_name,u.original_name,o.print_file_name FROM uploads u JOIN orders o ON o.upload_id=u.id WHERE o.id=$1 AND o.shop_id=$2`, [req.params.orderId, req.user.shopId]); if (!rows[0]) return res.status(404).json({ error: 'Document not found' }); const file = rows[0].print_file_name || rows[0].stored_name; if (!isSafeStoredFilename(file)) return res.status(400).json({ error: 'Document filename is invalid' }); const target = path.join(uploadDir, file); if (!fs.existsSync(target)) return res.status(410).json({ error: 'This file is no longer stored on the server' }); res.download(target, rows[0].print_file_name ? `photo-sheet-${req.params.orderId.slice(0, 8)}.pdf` : rows[0].original_name); }));

// Local print-agent API. A claim creates a lease and is atomic across agents.
router.post('/agent/:shopId/heartbeat', asyncRoute(async (req, res) => { const shop = await agentShop(req); if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' }); await pool.query('UPDATE shops SET agent_name=$2,agent_last_seen=now() WHERE id=$1', [shop.id, String(req.body.agentName || 'Print agent').slice(0, 100)]); res.json({ ok: true, serverTime: new Date().toISOString() }); }));
router.get('/agent/:shopId/jobs', asyncRoute(async (req, res) => {
  const shop = await agentShop(req);
  if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' });
  if (!isActive(shop)) return res.json({ job: null, locked: true, shopStatus: statusOf(shop) });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockPrintQueue(client, shop.id);
    const stale = await client.query(
      `UPDATE print_jobs
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
           claimed_by = NULL,
           error_message = CASE WHEN attempts >= 5 THEN 'The print agent did not finish this job after 5 attempts' ELSE error_message END
       WHERE shop_id = $1 AND status = 'claimed' AND claimed_at < now() - interval '15 minutes'
       RETURNING order_id, status`,
      [shop.id],
    );
    for (const row of stale.rows) {
      await client.query(
        'UPDATE orders SET print_status = $2, order_status = $3 WHERE id = $1',
        [row.order_id, row.status, row.status === 'failed' ? 'failed' : 'print_queued'],
      );
    }

    const { rows } = await client.query(
      `SELECT j.id job_id, o.id order_id, o.order_code, o.config, o.page_count,
              CASE WHEN o.config->>'mode' = 'photo' THEN 1 ELSE o.copies END copies,
              o.amount, COALESCE(o.print_file_name, u.stored_name) stored_name,
              CASE WHEN o.print_file_name IS NOT NULL THEN 'application/pdf' ELSE u.mime_type END mime_type,
              u.byte_size, COALESCE(o.print_file_name, u.original_name) original_name
       FROM print_jobs j
       JOIN orders o ON o.id = j.order_id
       JOIN uploads u ON u.id = o.upload_id
       WHERE j.shop_id = $1 AND j.status = 'queued' AND j.attempts < 5
         AND o.order_status = 'print_queued' AND o.payment_status = 'verified'
       ORDER BY j.queue_position, j.created_at, j.id
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 1`,
      [shop.id],
    );
    if (!rows[0]) {
      await client.query('COMMIT');
      return res.json({ job: null });
    }

    await client.query(
      `UPDATE print_jobs SET status = 'claimed', claimed_by = 'print-agent',
       claimed_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [rows[0].job_id],
    );
    await client.query(
      `UPDATE orders SET print_status = 'claimed', order_status = 'printing' WHERE id = $1`,
      [rows[0].order_id],
    );
    await client.query('COMMIT');
    return res.json({ job: { ...rows[0], downloadUrl: `/api/agent/${shop.public_id}/jobs/${rows[0].job_id}/document` } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));
router.get('/agent/:shopId/jobs/:jobId/document', asyncRoute(async (req, res) => { const shop = await agentShop(req); if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' }); const { rows } = await pool.query(`SELECT COALESCE(o.print_file_name,u.stored_name) stored_name,COALESCE(o.print_file_name,u.original_name) original_name FROM print_jobs j JOIN orders o ON o.id=j.order_id JOIN uploads u ON u.id=o.upload_id WHERE j.id=$1 AND j.shop_id=$2 AND j.claimed_by='print-agent' AND j.status IN ('claimed','printing')`, [req.params.jobId, shop.id]); if (!rows[0]) return res.status(404).json({ error: 'Claimed job not found' }); if (!isSafeStoredFilename(rows[0].stored_name)) return res.status(400).json({ error: 'Document filename is invalid' }); res.download(path.join(uploadDir, rows[0].stored_name), rows[0].original_name); }));
router.post('/agent/:shopId/jobs/:jobId/result', asyncRoute(async (req, res) => { const shop = await agentShop(req); if (!shop) return res.status(401).json({ error: 'Invalid print-agent token' }); const status = req.body.status; if (!['completed', 'failed'].includes(status)) return res.status(400).json({ error: 'Result must be completed or failed' }); const client = await pool.connect(); try { await client.query('BEGIN'); const { rows } = await client.query(`SELECT j.*,o.id order_id FROM print_jobs j JOIN orders o ON o.id=j.order_id WHERE j.id=$1 AND j.shop_id=$2 AND j.claimed_by='print-agent' AND j.status='claimed' FOR UPDATE OF j`, [req.params.jobId, shop.id]); if (!rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Job lease is no longer active' }); } const errorMessage = status === 'failed' ? String(req.body.error || 'Printer command failed').slice(0, 1000) : null; await client.query('UPDATE print_jobs SET status=$2,error_message=$3 WHERE id=$1', [rows[0].id, status, errorMessage]); await client.query('UPDATE orders SET print_status=$2,order_status=$3,completed_at=CASE WHEN $2=\'completed\' THEN now() ELSE completed_at END WHERE id=$1', [rows[0].order_id, status, status === 'completed' ? 'completed' : 'failed']); await client.query('COMMIT'); res.json({ ok: true }); } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }));

async function transitionOrder(req, res, action) {
  const shopId = req.user.shopId; const id = req.params.orderId; const client = await pool.connect();
  try {
    await client.query('BEGIN'); await lockPrintQueue(client, shopId); const { rows } = await client.query('SELECT * FROM orders WHERE id=$1 AND shop_id=$2 FOR UPDATE', [id, shopId]); const order = rows[0]; if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
    if (action === 'cash-confirm') {
      if (order.payment_method !== 'cash' || order.order_status !== 'cash_confirmation_pending') throw Object.assign(new Error('Cash order is not awaiting confirmation'), { status: 409 });
      await queueForPrint(client, order); await client.query(`UPDATE orders SET order_status='print_queued',print_status='queued',payment_status='verified',confirmed_at=now() WHERE id=$1`, [id]);
    } else if (action === 'payment-verify') {
      if (order.payment_method !== 'upi' || !['pending_payment', 'payment_review'].includes(order.order_status) || order.payment_status !== 'pending') throw Object.assign(new Error('UPI order is not awaiting shop verification'), { status: 409 });
      const verified = Boolean(req.body.verified); if (verified) { await queueForPrint(client, order); await client.query(`UPDATE orders SET payment_status='verified',order_status='print_queued',print_status='queued',confirmed_at=now() WHERE id=$1`, [id]); await client.query(`UPDATE payments SET status='verified',verified_by=$2 WHERE order_id=$1`, [id, req.user.email]); } else { await client.query(`UPDATE orders SET payment_status='failed',order_status='failed' WHERE id=$1`, [id]); await client.query(`UPDATE payments SET status='failed',verified_by=$2 WHERE order_id=$1`, [id, req.user.email]); }
    } else if (action === 'cancel') {
      if (['completed', 'printing', 'cancelled'].includes(order.order_status)) throw Object.assign(new Error('This order cannot be cancelled in its current state'), { status: 409 }); await client.query(`DELETE FROM print_jobs WHERE order_id=$1 AND status='queued'`, [id]); await client.query(`UPDATE orders SET print_status='not_ready',order_status='cancelled',payment_status=CASE WHEN payment_status='pending' THEN 'cancelled' ELSE payment_status END WHERE id=$1`, [id]); await client.query(`UPDATE payments SET status='cancelled' WHERE order_id=$1 AND status='pending'`, [id]);
    } else if (action === 'print-failed') {
      if (order.files_deleted_at) throw Object.assign(new Error('Print files were deleted after the 10-minute retention period and cannot be retried'), { status: 409 });
      if (!['claimed', 'printing', 'failed', 'completed'].includes(order.print_status)) throw Object.assign(new Error('Only jobs that are printing, failed or completed can be marked failed'), { status: 409 }); await client.query(`UPDATE print_jobs SET status='failed',error_message=$2 WHERE order_id=$1`, [id, String(req.body.reason || 'Marked failed by shop admin').slice(0, 1000)]); await client.query(`UPDATE orders SET order_status='failed',print_status='failed' WHERE id=$1`, [id]);
    } else if (action === 'retry-print') {
      if (order.order_status !== 'failed' || order.payment_status !== 'verified') throw Object.assign(new Error('Only paid, failed orders can be requeued'), { status: 409 }); await requeuePrintJob(client, order); await client.query(`UPDATE orders SET order_status='print_queued',print_status='queued' WHERE id=$1`, [id]);
    } else if (action === 'complete') {
      const done = await client.query(`UPDATE orders SET order_status='completed',print_status='completed',completed_at=now() WHERE id=$1 AND order_status='printing'`, [id]); if (!done.rowCount) throw Object.assign(new Error('Only an order that is printing can be marked complete'), { status: 409 }); await client.query(`UPDATE print_jobs SET status='completed' WHERE order_id=$1`, [id]);
    }
    await client.query('INSERT INTO audit_log(shop_id,actor,action,details) VALUES($1,$2,$3,$4)', [shopId, req.user.email, `order.${action}`, { orderCode: order.order_code }]); const { rows: updated } = await client.query('SELECT * FROM orders WHERE id=$1', [id]); await client.query('COMMIT'); res.json({ order: updated[0] });
  } catch (e) { await client.query('ROLLBACK'); if (e.status) return res.status(e.status).json({ error: e.message }); throw e; } finally { client.release(); }
}
async function lockPrintQueue(client, shopId) { await client.query("SELECT pg_advisory_xact_lock(hashtext('print-wallah-queue'), hashtext($1))", [String(shopId)]); }
async function nextPrintQueuePosition(client) { return (await client.query("SELECT nextval('print_queue_position_seq')::bigint position")).rows[0].position; }
async function queueForPrint(client, order) {
  const position = await nextPrintQueuePosition(client);
  await client.query(`INSERT INTO print_jobs(order_id,shop_id,status,queue_position) VALUES($1,$2,'queued',$3) ON CONFLICT(order_id) DO NOTHING`, [order.id, order.shop_id, position]);
}
async function requeuePrintJob(client, order) {
  const position = await nextPrintQueuePosition(client);
  await client.query(
    `INSERT INTO print_jobs(order_id,shop_id,status,queue_position) VALUES($1,$2,'queued',$3)
     ON CONFLICT(order_id) DO UPDATE SET id=gen_random_uuid(),status='queued',queue_position=EXCLUDED.queue_position,
       attempts=0,error_message=NULL,claimed_by=NULL,claimed_at=NULL,updated_at=now()`,
    [order.id, order.shop_id, position],
  );
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
  const { rows: uploadedFiles } = await pool.query(
    `SELECT * FROM uploads WHERE public_token = ANY($1::text[]) AND shop_id=$2 AND expires_at>now()`,
    [documentTokens, shop.id],
  );
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
      const upload = String(item.uploadToken) === String(body.uploadToken) ? file : (await pool.query(`SELECT * FROM uploads WHERE public_token=$1 AND shop_id=$2 AND expires_at>now()`, [String(item.uploadToken || ''), shop.id])).rows[0];
      if (!upload || upload.mime_type === 'application/pdf') throw Object.assign(new Error('One of the photos has expired. Upload it again.'), { status: 400 });
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

function createPhotoPrintFile(items, outputPath, config) {
  return new Promise((resolve, reject) => {
    const cm = 72 / 2.54, g = photoGeometry(config.photoSize, config.paperSize, config.orientation);
    const margin = g.marginCm * cm, gap = g.gapCm * cm;
    const photoW = g.widthCm * cm, photoH = g.heightCm * cm, cellW = g.cellWidthCm * cm, cellH = g.cellHeightCm * cm;
    const pageOptions = { size: config.paperSize, layout: config.orientation, margins: { top: 0, right: 0, bottom: 0, left: 0 } };
    const doc = new PDFDocument({ ...pageOptions, compress: true }), out = fs.createWriteStream(outputPath);
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; if (error) { fs.rmSync(outputPath, { force: true }); reject(error); } else resolve(); };
    out.on('finish', () => finish()); out.on('error', finish); doc.on('error', finish); doc.pipe(out);
    try {
      let index = 0;
      for (const item of items) {
        if (!isSafeStoredFilename(item.upload.stored_name)) throw new Error('Uploaded image has an invalid stored filename');
        for (let n = 0; n < item.quantity; n++, index++) {
          const page = Math.floor(index / g.capacity);
          if (page > 0 && index % g.capacity === 0) doc.addPage(pageOptions);
          const slot = index % g.capacity, col = slot % g.columns, row = Math.floor(slot / g.columns);
          const x = margin + col * (cellW + gap), y = margin + row * (cellH + gap);
          const imagePath = path.join(uploadDir, item.upload.stored_name);
          const box = config.photoFit === 'contain' ? { fit: [photoW, photoH] } : { cover: [photoW, photoH] };
          doc.save();
          if (g.rotated) { doc.translate(x + cellW, y); doc.rotate(90); doc.image(imagePath, 0, 0, { ...box, align: 'center', valign: 'center' }); }
          else doc.image(imagePath, x, y, { ...box, align: 'center', valign: 'center' });
          doc.restore();
          doc.rect(x, y, cellW, cellH).lineWidth(0.4).strokeColor('#8a8f8a').stroke(); // hairline cut guide
        }
      }
      doc.end();
    } catch (error) { finish(error); }
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
