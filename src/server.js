require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const fs = require('node:fs');
const { getFirebase } = require('./firebase');
const { COLLECTIONS } = require('./firestoreStore');
const { fileStorage } = require('./services/fileStorage');
const api = require('./routes/api');
const { createAgentLeaseRouter } = require('./routes/agentLease');
const { cleanupCompletedOrderFiles } = require('./services/retention');
const { cleanupExpiredUploads } = require('./services/uploadRetention');
const jwt = require('jsonwebtoken');
const { lanAddresses } = require('./services/network');
const { webhookEnabled } = require('./services/webhook');

const production = process.env.NODE_ENV === 'production';
const limiter = (limit, options = {}) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait a few minutes and try again.' }, ...options });

function requireConfig() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('Configure JWT_SECRET with a private random value of at least 32 characters.');
  }
  if (!String(process.env.SUPER_ADMIN_EMAIL || '').trim()) {
    throw new Error('Configure SUPER_ADMIN_EMAIL before starting Print Wallah.');
  }
  if (!String(process.env.SUPER_ADMIN_PASSWORD || '')) {
    throw new Error('Configure SUPER_ADMIN_PASSWORD before starting Print Wallah.');
  }
  if (!String(process.env.FIREBASE_PROJECT_ID || '').trim() || !String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()) {
    throw new Error('Configure FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON before starting Print Wallah.');
  }
  if (![process.env.R2_ACCOUNT_ID, process.env.R2_ACCESS_KEY_ID, process.env.R2_SECRET_ACCESS_KEY, process.env.R2_BUCKET_NAME].every((value) => String(value || '').trim())) {
    throw new Error('Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME before starting Print Wallah.');
  }
  process.env.STORAGE_PROVIDER = 'r2';
}

async function main() {
  requireConfig();
  const { db } = getFirebase();
  const cleanupUploads = async () => {
    const { uploadsDeleted } = await cleanupExpiredUploads({ db, storage: fileStorage });
    if (uploadsDeleted) console.log(`Removed ${uploadsDeleted} expired unclaimed upload(s)`);
  };
  cleanupUploads().catch(error => console.error('Upload cleanup failed:', error.message));
  const cleanupTimer = setInterval(() => cleanupUploads().catch(error => console.error('Upload cleanup failed:', error.message)), 60 * 60 * 1000);
  cleanupTimer.unref();
  const cleanupCompletedFiles = () => cleanupCompletedOrderFiles({ db, storage: fileStorage })
    .then(({ ordersDeleted }) => { if (ordersDeleted) console.log(`Deleted print files for ${ordersDeleted} completed order(s)`); })
    .catch(error => console.error('Completed-order file cleanup failed:', error?.stack || error));
  cleanupCompletedFiles();
  const retentionTimer = setInterval(cleanupCompletedFiles, 60 * 1000);
  retentionTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', production ? 1 : false);
  app.use(helmet({
    // Over plain HTTP on a LAN address, "upgrade-insecure-requests" would make the phone request https:// assets and fail, so it is production only.
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], workerSrc: ["'self'", 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: null, upgradeInsecureRequests: production ? [] : null } },
    frameguard: false,
    crossOriginOpenerPolicy: production ? undefined : false,
    originAgentCluster: production ? undefined : false,
    hsts: production ? undefined : false,
  }));
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(cookieParser());
  app.use((req, _res, next) => {
    const value = req.cookies?.session;
    if (value) try { req.user = jwt.verify(value, process.env.JWT_SECRET, { issuer: 'print-wallah' }); } catch { req.user = null; }
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/auth', limiter(25, { skipSuccessfulRequests: true }));
  app.use('/api/shops', limiter(900));
  app.use('/api/orders', limiter(900, { skip: (req) => req.method !== 'GET' }));
  app.use('/api/orders', limiter(80, { skip: (req) => req.method === 'GET' }));
  app.use('/api/agent/:shopId', createAgentLeaseRouter());
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  // Until the real logo is dropped in as public/assets/logo.png, serve the placeholder at the same URL so pages never show a broken image or a 404.
  app.get('/assets/logo.png', (_req, res, next) => {
    const real = path.join(__dirname, '..', 'public', 'assets', 'logo.png');
    if (fs.existsSync(real)) return next();
    const printWallahLogo = path.join(__dirname, '..', 'public', 'assets', 'Print-Wallah_icon.png');
    if (fs.existsSync(printWallahLogo)) {
      res.set('Cache-Control', 'no-cache').type('image/png').sendFile(printWallahLogo);
      return;
    }
    res.status(404).end();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use('/docs', express.static(path.join(__dirname, '..', 'docs'), { dotfiles: 'deny', index: false }));
  app.get(['/shop/:shopId', '/admin', '/login'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  app.use((error, _req, res, _next) => {
    if (error instanceof require('multer').MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${process.env.MAX_UPLOAD_MB || 30} MB limit` : error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request body' });
    const status = error.status || 500;
    if (status >= 500) console.error('Request error:', error.stack || error.message);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : error.message });
  });

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0'; // reachable from other devices on the same network; set HOST=127.0.0.1 to keep it local
  const server = app.listen(port, host, () => printBanner(port, host));
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other process or set PORT in .env.` : `Server error: ${error.message}`); process.exit(1); });
  const shutdown = () => { clearInterval(cleanupTimer); clearInterval(retentionTimer); server.close(() => process.exit(0)); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

function printBanner(port, host) {
  const lan = host === '127.0.0.1' || host === 'localhost' ? [] : lanAddresses();
  const line = (label, value) => console.log(`  ${label.padEnd(16)}${value}`);
  console.log(`\nPrint Wallah is running (${production ? 'production' : 'development'})\n`);
  line('Local:', `http://localhost:${port}`);
  if (lan.length) lan.forEach((item) => line('Network:', `http://${item.address}:${port}`));
  else if (host !== '127.0.0.1' && host !== 'localhost') line('Network:', 'unavailable');
  line('Payments:', webhookEnabled() ? 'webhook receiver (provider adapter required)' : 'manual verification');
  if (production && (!process.env.APP_URL || !/^https:\/\//.test(process.env.APP_URL))) {
    console.warn('  WARNING: set APP_URL to the public https:// address so QR codes and UPI flows work.');
  }
  console.log('');
}

main().catch((error) => { console.error('Startup failed:', error.message); process.exit(1); });
