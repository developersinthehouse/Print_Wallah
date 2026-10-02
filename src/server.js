require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const fs = require('node:fs');
const { initialize, pool } = require('./db');
const api = require('./routes/api');
const { createAgentLeaseRouter } = require('./routes/agentLease');
const { cleanupCompletedOrderFiles } = require('./services/retention');
const jwt = require('jsonwebtoken');
const { lanAddresses, isLocalHost } = require('./services/network');
const { webhookEnabled } = require('./services/webhook');

const production = process.env.NODE_ENV === 'production';
const limiter = (limit, options = {}) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait a few minutes and try again.' }, ...options });

function requireConfig() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be set and contain at least 32 characters');
  if (!String(process.env.SUPER_ADMIN_EMAIL || '').trim() || !String(process.env.SUPER_ADMIN_PASSWORD || '')) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in .env (restart the server after editing .env)');
}

async function main() {
  requireConfig();
  await initialize();
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage');
  fs.mkdirSync(uploadDir, { recursive: true });
  const cleanupUploads = async () => {
    const { rows } = await pool.query(`DELETE FROM uploads u WHERE u.expires_at<now() AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.upload_id=u.id) AND NOT EXISTS(SELECT 1 FROM order_uploads x WHERE x.upload_id=u.id) RETURNING stored_name`);
    for (const row of rows) fs.rmSync(path.join(uploadDir, path.basename(row.stored_name)), { force: true });
    if (rows.length) console.log(`Removed ${rows.length} expired unclaimed upload(s)`);
  };
  cleanupUploads().catch(error => console.error('Upload cleanup failed:', error.message));
  const cleanupTimer = setInterval(() => cleanupUploads().catch(error => console.error('Upload cleanup failed:', error.message)), 60 * 60 * 1000);
  cleanupTimer.unref();
  const cleanupCompletedFiles = () => cleanupCompletedOrderFiles({ pool, uploadDir })
    .then(({ ordersDeleted }) => { if (ordersDeleted) console.log(`Deleted print files for ${ordersDeleted} completed order(s)`); })
    .catch(error => console.error('Completed-order file cleanup failed:', error.message));
  cleanupCompletedFiles();
  const retentionTimer = setInterval(cleanupCompletedFiles, 60 * 1000);
  retentionTimer.unref();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', production ? 1 : false);
  app.use(helmet({
    // Over plain HTTP on a LAN address, "upgrade-insecure-requests" would make the phone request https:// assets and fail, so it is production only.
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], workerSrc: ["'self'", 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], frameSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: production ? [] : null } },
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
  app.use('/api/agent/:shopId', createAgentLeaseRouter(pool));
  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  // Until the real logo is dropped in as public/assets/logo.png, serve the placeholder at the same URL so pages never show a broken image or a 404.
  app.get('/assets/logo.png', (_req, res, next) => {
    const real = path.join(__dirname, '..', 'public', 'assets', 'logo.png');
    if (fs.existsSync(real)) return next();
    const printWallahLogo = path.join(__dirname, '..', 'public', 'assets', 'print-wallah_logo.png');
    if (fs.existsSync(printWallahLogo)) {
      res.set('Cache-Control', 'no-cache').type('image/png').sendFile(printWallahLogo);
      return;
    }
    res.set('Cache-Control', 'no-cache').type('image/svg+xml').sendFile(path.join(__dirname, '..', 'public', 'assets', 'logo-placeholder.svg'));
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
  const shutdown = () => { clearInterval(cleanupTimer); clearInterval(retentionTimer); server.close(async () => { await pool.end(); process.exit(0); }); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

function printBanner(port, host) {
  const lan = host === '127.0.0.1' || host === 'localhost' ? [] : lanAddresses();
  const line = (label, value) => console.log(`  ${label.padEnd(16)}${value}`);
  console.log(`\nPrint Wallah is running (${production ? 'production' : 'development'})\n`);
  line('Local:', `http://localhost:${port}`);
  if (lan.length) lan.forEach((item, i) => line(i === 0 ? 'Network:' : '', `http://${item.address}:${port}${i === 0 ? '   <- open this on your phone (same Wi-Fi)' : `   (${item.name})`}`));
  else if (host !== '127.0.0.1' && host !== 'localhost') line('Network:', 'no LAN address found. Connect to Wi-Fi/Ethernet.');
  line('API base:', `http://localhost:${port}/api${lan[0] ? `  |  http://${lan[0].address}:${port}/api` : ''}`);
  line('Health check:', `http://localhost:${port}/api/health`);
  line('Super Admin:', `/    Shop Admin: /admin    Customer: /shop/<shop id>`);
  console.log('');
  console.log('  The frontend and API are one server, so the phone uses the same address for both (no CORS or API URL to configure).');
  if (!production) {
    let appHost = ''; try { appHost = new URL(process.env.APP_URL).host; } catch { /* unset */ }
    if (!appHost || isLocalHost(appHost)) console.log('  APP_URL is localhost or unset: shop QR codes use the address you open the site with. Open Super Admin via the Network URL to create QR codes a phone can scan.');
    if (lan.length) console.log('  If the phone cannot connect, allow Node.js through the firewall for private networks and confirm both devices are on the same Wi-Fi.');
  } else if (!process.env.APP_URL || !/^https:\/\//.test(process.env.APP_URL)) console.warn('  WARNING: set APP_URL to the public https:// address so QR codes and UPI flows work.');
  console.log(`  Payment webhook: ${webhookEnabled() ? 'enabled (POST /api/payments/webhook)' : 'disabled (manual UPI verification)'}\n`);
}

main().catch((error) => { console.error('Startup failed:', error.message); process.exit(1); });
