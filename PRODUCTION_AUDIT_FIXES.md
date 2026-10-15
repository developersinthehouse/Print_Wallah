# Print Wallah - Production Audit & Complete Bug Fix Specification

Ye document un sabhi issues, root causes, aur exact code changes ko cover karta hai jo Render deployment aur production environment me Print Wallah ko stably run karne ke liye zaroori hain. Is document ko directly kisi bhi AI coding assistant ko dekar execute karwaya ja sakta hai.

---

## 1. Backend Server & Database Connection

### 1.1 `src/db.js` - SSL Conflict on Cloud PostgreSQL (Neon / Render / Supabase)
- **Problem:** `src/db.js` me line 6 par regex replace `sslmode=verify-full` enforce karta hai:
  ```javascript
  const connectionString = process.env.DATABASE_URL.replace(
    /([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/i,
    '$1verify-full',
  );
  ```
  Iske saath line 12 par `rejectUnauthorized: false` set hai. `verify-full` Node TLS root store check enforce karta hai, jisse Neon/Render/AWS RDS self-signed certificates par `SELF_SIGNED_CERT_IN_CHAIN` ya hostname mismatch error se boot fail ho jata hai.
- **File:** `src/db.js`
- **Fix:**
  Forced `verify-full` regex hatao aur SSL configuration ko clean karo:
  ```javascript
  const fs = require('node:fs');
  const path = require('node:path');
  const { Pool } = require('pg');

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  let ssl = undefined;
  if (process.env.DATABASE_SSL === 'true') {
    ssl = { rejectUnauthorized: false };
  } else if (process.env.DATABASE_SSL === 'strict') {
    ssl = true;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (error) => console.error('Unexpected database pool error', error.message));

  async function initialize() {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
  }
  module.exports = { pool, initialize };
  ```

---

### 1.2 `src/server.js` - Server Startup par Heavy Schema DDL & Extension Crashes
- **Problem:** `server.js` ke andar line 29 par `await initialize()` har boot/restart par chalta hai.
  1. `schema.sql` me line 1 par `CREATE EXTENSION IF NOT EXISTS pgcrypto;` hai. Render managed DB user superuser nahi hota, jisse permission denied error throw hoti hai aur server crash ho jata hai.
  2. Heavy `DO $$ ... END $$` blocks aur table locking se multi-instance ya zero-downtime deploy par deadlocks aate hain.
  3. `setval('print_queue_position_seq')` har baar reset hota hai.
- **File:** `src/server.js`
- **Fix:**
  `server.js` me startup par `await initialize()` ki jagah lightweight health check `await pool.query('SELECT 1');` use karo:
  ```javascript
  // src/server.js line 29:
  // Schema initialization should only run via 'npm run db:init' or deployment pre-deploy hook.
  await pool.query('SELECT 1');
  ```
  Aur `package.json` me pre-start script ya build command me `npm run db:init` ensure karo.

---

### 1.3 `src/middleware/auth.js` - HTTPS Production Cookie Clear Bug
- **Problem:** Line 13 par jab session expire hota hai:
  ```javascript
  catch { res.clearCookie('session', { path: '/' }); res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
  ```
  `res.clearCookie()` me `secure: true` aur `sameSite: 'lax'` pass nahi hota. RFC 6265 ke mutabiq browser HTTPS me stale cookie ko delete karne se mana kar deta hai, jisse persistent 401 loop shuru ho jata hai.
- **File:** `src/middleware/auth.js`
- **Fix:**
  Line 13 ko replace karo:
  ```javascript
  catch {
    res.clearCookie('session', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    });
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
  ```

---

### 1.4 `src/routes/agentLease.js` - Agent Lease Heartbeat Status Mismatch & UUID Validation
- **Problem:**
  1. Line 30 par `WHERE ... status = 'claimed'` check hai. Jab print agent print shuru karke status `'printing'` kar deta hai, to continuous heartbeat 0 rows return karta hai aur HTTP 409 "Job lease is no longer active" throw hota hai, jisse print job abort ho jata hai.
  2. Line 32 par `request.params.jobId` direct query me jata hai bina UUID format check ke. Malformed string par Postgres 500 error deta hai.
- **File:** `src/routes/agentLease.js`
- **Fix:**
  UUID regex check add karo aur status check me `'printing'` include karo:
  ```javascript
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  router.post('/jobs/:jobId/heartbeat', async (request, response, next) => {
    if (!UUID_REGEX.test(request.params.jobId)) {
      return response.status(400).json({ error: 'Invalid job ID format' });
    }
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
    if (!tokenMatch) return response.status(401).json({ error: 'Invalid print-agent token' });

    try {
      const shopResult = await pool.query(
        'SELECT id FROM shops WHERE public_id = $1 AND agent_token_hash = $2',
        [request.params.shopId, hashToken(tokenMatch[1])],
      );
      const shop = shopResult.rows[0];
      if (!shop) return response.status(401).json({ error: 'Invalid print-agent token' });

      const leaseResult = await pool.query(
        `UPDATE print_jobs
         SET claimed_at = NOW()
         WHERE id = $1 AND shop_id = $2 AND claimed_by = 'print-agent' AND status IN ('claimed', 'printing')
         RETURNING id`,
        [request.params.jobId, shop.id],
      );
      if (!leaseResult.rows[0]) return response.status(409).json({ error: 'Job lease is no longer active' });

      await pool.query('UPDATE shops SET agent_last_seen = NOW() WHERE id = $1', [shop.id]);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });
  ```

---

## 2. API Routes (`src/routes/api.js`)

### 2.1 Unhandled `TypeError` in `POST /super/shops`
- **Problem:** Line 155-168:
  ```javascript
  let client;
  try {
    client = await pool.connect();
    ...
  } catch (error) {
    await client.query('ROLLBACK'); // agar connect() fail hua to client undefined hoga -> TypeError crash!
  } finally {
    client.release(); // TypeError: Cannot read properties of undefined (reading 'release')
  }
  ```
- **File:** `src/routes/api.js`
- **Fix:** Optional chaining aur safety guard use karo:
  ```javascript
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'A shop already uses that admin email' });
    throw error;
  } finally {
    client?.release();
  }
  ```

---

### 2.2 Duplicate Route Declarations
- **Problem:**
  - `GET /super/analytics` lines 123-127 aur lines 133-137 par do baar define hai.
  - `GET /admin/analytics` lines 128-132 aur lines 619-623 par do baar define hai.
- **File:** `src/routes/api.js`
- **Fix:** Redundant duplicate route definitions (lines 133-137 aur lines 619-623) ko delete karo.

---

### 2.3 Bypass of Session Invalidation in `GET /session`
- **Problem:** Line 85-87 par `/session` sirf shop existence check karta hai:
  ```javascript
  const { rows } = await pool.query('SELECT public_id,name FROM shops WHERE id=$1', [req.user.shopId]);
  ```
  Agar shop super admin ne lock kar di ho (`manually_locked=true`), access expire ho chuka ho, ya password/email badal gaya ho (`sessionStamp`), fir bhi frontend ko valid `shop_admin` status milta hai.
- **File:** `src/routes/api.js`
- **Fix:**
  ```javascript
  router.get('/session', asyncRoute(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    if (req.user.role === 'super_admin') return res.json({ user: { role: 'super_admin', email: req.user.email } });
    if (req.user.role !== 'shop_admin') return res.json({ user: null });
    const { rows } = await pool.query('SELECT * FROM shops WHERE id=$1', [req.user.shopId]);
    const shop = rows[0];
    if (!shop || !isActive(shop) || req.user.pv !== sessionStamp(shop)) {
      res.clearCookie('session', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
      return res.json({ user: null });
    }
    res.json({ user: { role: 'shop_admin', shopId: shop.public_id, email: req.user.email, shopName: shop.name } });
  }));
  ```

---

### 2.4 Empty Value Corruption in `PATCH /admin/settings`
- **Problem:** Line 624 par:
  `[shop.id, b.name ?? shop.name, b.ownerName ?? shop.owner_name, ...]`
  Agar admin input field ko khali (`""`) submit kar de, to nullish coalescing `""` ko accept kar leta hai aur shop name, phone ya owner name DB me empty wipe ho jata hai.
- **File:** `src/routes/api.js`
- **Fix:**
  Trim aur non-empty check lagao:
  ```javascript
  const trimOrFallback = (val, fallback) => (typeof val === 'string' && val.trim() ? val.trim() : fallback);
  const name = trimOrFallback(b.name, shop.name);
  const ownerName = trimOrFallback(b.ownerName, shop.owner_name);
  const phone = trimOrFallback(b.phone, shop.phone);
  const address = trimOrFallback(b.address, shop.address);
  const city = trimOrFallback(b.city, shop.city);
  ```

---

### 2.5 Invalid Date Query in `GET /admin/orders` (PostgreSQL 500 Crash)
- **Problem:** Line 532:
  `req.query.from` aur `req.query.to` bina regex validation ke direct SQL me `$X::date` cast hote hain. Koi invalid date string dalne par Postgres error `22007: invalid input syntax for type date` se 500 error deta hai.
- **File:** `src/routes/api.js`
- **Fix:** Date format validate karo:
  ```javascript
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  if (req.query.from && DATE_REGEX.test(String(req.query.from))) { ... }
  if (req.query.to && DATE_REGEX.test(String(req.query.to))) { ... }
  ```

---

### 2.6 Audit Logging for Agent Token Rotation
- **Problem:** Line 625 par `POST /admin/agent/rotate` token hash update karta hai par audit log generate nahi karta.
- **File:** `src/routes/api.js`
- **Fix:**
  ```javascript
  router.post('/admin/agent/rotate', ...admin, asyncRoute(async (req, res) => {
    const value = token();
    await pool.query('UPDATE shops SET agent_token_hash=$2 WHERE id=$1', [req.user.shopId, sha256(value)]);
    await audit(req.user.shopId, req.user.email, 'shop.agent_token.rotated');
    res.json({ agentToken: value });
  }));
  ```

---

## 3. Services Layer (`src/services/`)

### 3.1 `src/services/core.js` - Invalid Date State Handling & Photo Pricing Validation
- **Problem:**
  1. Lines 8-15: Agar `shop.access_end` invalid ho, `isActive` false deta hai par `statusOf` fallback hokar `'active'` return kar deta hai (inconsistent state).
  2. Lines 30-31: `photoRate` finite check miss karta hai. Agar rate galat ho to `NaN` total calculate hota hai.
- **File:** `src/services/core.js`
- **Fix:**
  ```javascript
  function isActive(shop, now = new Date()) {
    if (!shop || shop.manually_locked) return false;
    const end = new Date(shop.access_end);
    return !Number.isNaN(end.getTime()) && end > now;
  }

  function statusOf(shop, now = new Date()) {
    if (!shop || shop.manually_locked) return 'locked';
    const end = new Date(shop.access_end);
    if (Number.isNaN(end.getTime()) || end <= now) return 'expired';
    return 'active';
  }
  ```
  Aur `calculatePrice()` me:
  ```javascript
  const rawPhotoRate = size === 'A3' && pricing.photo_sheet_a3 !== undefined && pricing.photo_sheet_a3 !== null && pricing.photo_sheet_a3 !== '' ? Number(pricing.photo_sheet_a3) : Number(pricing.photo_sheet || 0);
  const photoRate = Number.isFinite(rawPhotoRate) && rawPhotoRate >= 0 ? rawPhotoRate : 0;
  if (photoSheets > 0 && (!Number.isFinite(rawPhotoRate) || rawPhotoRate < 0)) {
    throw new Error('Photo sheet pricing is not configured properly');
  }
  ```

---

### 3.2 `src/services/documentBundle.js` - Case Sensitivity Bug in `PAPER_POINTS`
- **Problem:** Line 19 par `PAPER_POINTS[config.paperSize]` direct access hota hai. Agar `config.paperSize` lowercase `'a3'` ya `'a4'` aaye, to undefined ho kar default `A4` ban jata hai, jisse customer ki A3 order galat print hoti hai.
- **File:** `src/services/documentBundle.js`
- **Fix:**
  ```javascript
  const sizeKey = String(config?.paperSize || 'A4').toUpperCase();
  const [paperWidth, paperHeight] = PAPER_POINTS[sizeKey] || PAPER_POINTS.A4;
  ```

---

### 3.3 `src/services/fileStorage.js` - Local Storage Folder Auto-creation
- **Problem:**
  `fileStorage.put()` me local provider use karte waqt agar folder exist na kare (e.g. CLI tools ya background jobs me) to `ENOENT` crash ho jata hai.
- **File:** `src/services/fileStorage.js`
- **Fix:**
  Local provider ke `put()` me `await fs.mkdir(directory, { recursive: true });` ensure karo.

---

### 3.4 `src/services/upi.js` - Empty Payee Name Bug (`&pn=&`) & Hyphen Issue
- **Problem:**
  1. Line 23: Agar shop ka `upi_name` empty ho, to URI me `&pn=&` jata hai. NPCI standard ke tehat Google Pay, PhonePe, Paytm empty `pn` link ko reject kar dete hain ("Invalid Payee Details").
  2. Line 27: Kuch bank PSPs (SBI/HDFC) `tr` me hyphens reject karte hain.
- **File:** `src/services/upi.js`
- **Fix:**
  ```javascript
  function buildUpiUri({ upiId, payeeName, amount, orderCode }) {
    if (!isValidUpiId(upiId)) throw new Error('Shop UPI ID is not valid');
    const am = Number(amount);
    if (!Number.isFinite(am) || am <= 0 || am > 100000 || Number(am.toFixed(2)) <= 0) throw new Error('Order amount is not payable through UPI');
    if (!ORDER_REF.test(String(orderCode ?? ''))) throw new Error('Order reference is not valid for UPI');
    
    const cleanedName = String(payeeName || 'Print Shop').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const name = cleanedName || 'Print Shop';
    const enc = (value) => encodeURIComponent(value);
    
    const params = [
      ['pa', enc(upiId).replace(/%40/g, '@')],
      ['pn', enc(name)],
      ['am', am.toFixed(2)],
      ['cu', 'INR'],
      ['tr', enc(String(orderCode).replace(/-/g, ''))],
      ['tn', enc(`Print order ${orderCode}`)],
    ];
    return 'upi://pay?' + params.map(([k, v]) => `${k}=${v}`).join('&');
  }
  ```

---

### 3.5 `src/services/reports.js` - Empty String SQL Integer Cast Crash
- **Problem:** Line 48 aur 81 par `coalesce(sum((config->>'billablePages')::int), 0)` hai. Agar kisi order ke config me `billablePages` empty string `""` ho ya nullish ho, to Postgres `invalid input syntax for integer` se crash karta hai.
- **File:** `src/services/reports.js`
- **Fix:**
  `NULLIF` use karo:
  ```sql
  coalesce(sum(NULLIF(config->>'billablePages', '')::numeric::int), 0)::int AS pages
  ```

---

## 4. Frontend Bugs (`public/`)

### 4.1 `public/upiLaunch.js` - iOS Safari / WebKit UPI Protocol Parsing Crash
- **Problem:** Line 35:
  ```javascript
  function parseUpiUri(uri) {
    let url;
    try { url = new URL(String(uri)); } catch { return null; }
    if (url.protocol !== 'upi:' || url.hostname !== 'pay' || !url.search) return null;
  ```
  WebKit (iOS Safari / Mac Safari) me custom scheme `upi://pay?query` ke liye `url.hostname` **khali (`""`)** hota hai aur `url.pathname` `"//pay"` hota hai.
  Is wajah se har iPhone par UPI open button fail hota hai aur blocked hint dikhata hai.
- **File:** `public/upiLaunch.js`
- **Fix:**
  ```javascript
  function parseUpiUri(uri) {
    let url;
    try { url = new URL(String(uri)); } catch { return null; }
    const host = url.hostname || url.pathname.replace(/^\/\//, '').split('/')[0];
    if (url.protocol !== 'upi:' || host !== 'pay' || !url.search) return null;
    return url;
  }
  ```

---

### 4.2 `public/customer.js` - Payment Rejection Misleading Customer as "Printer Error"
- **Problem:** Line 48-49:
  ```javascript
  const TERMINAL = new Set(['completed', 'cancelled']);
  const isTerminal = (o) => TERMINAL.has(o.status) || ['cancelled', 'rejected', 'failed'].includes(o.paymentStatus) && o.status !== 'failed';
  ```
  Jab shop admin UPI payment ko "Not received" karta hai, backend `order_status='failed'` AND `payment_status='failed'` set karta hai.
  `o.status !== 'failed'` check ki wajah se `isTerminal` false ho jata hai aur customer screen par:
  > *"There was a problem printing... shop will retry"*
  dikhai deta hai.
- **File:** `public/customer.js`
- **Fix:**
  ```javascript
  const isTerminal = (o) => TERMINAL.has(o.status) || ['cancelled', 'rejected', 'failed'].includes(o.paymentStatus);
  ```

---

### 4.3 `public/admin.js` - Super Admin Shop Create/Edit me Glossy A3 & Photo Sheet A3 Discard Hona
- **Problem:** Line 530 (`showCreateShop`) aur Line 539 (`showEditShop`):
  Submit handler me pricing keys hardcoded 6 hain:
  `['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet']`
  Input fields me `glossy_a3` aur `photo_sheet_a3` render hote hain, par save hote waqt array me na hone ke karan silently discard ho jate hain.
- **File:** `public/admin.js`
- **Fix:**
  Dono jagah keys array me `glossy_a3` aur `photo_sheet_a3` include karo:
  ```javascript
  const ALL_PRICE_KEYS = ['bw_a4', 'color_a4', 'bw_a3', 'color_a3', 'glossy_a4', 'photo_sheet', 'glossy_a3', 'photo_sheet_a3'];
  b.pricing = Object.fromEntries(
    ALL_PRICE_KEYS
      .filter(k => !((k === 'glossy_a3' || k === 'photo_sheet_a3') && String(b[k] ?? '') === ''))
      .map(k => [k, Number(b[k])])
  );
  ```

---

### 4.4 `public/admin.js` & `public/admin.css` - Queue Drag-and-Drop Reordering Blocked
- **Problem:** `public/admin.js` line 278-280 par `document.elementFromPoint(clientX, clientY)` use hota hai. Lekin dragged element `.a-order.is-dragging` me `pointer-events: none` nahi hai, isliye pointer ke niche hamesha wahi card rehta hai aur intermediate cards detect nahi ho paate.
- **Files:** `public/admin.css`, `public/admin.js`
- **Fix:**
  `public/admin.css` line 128 me add karo:
  ```css
  .a-order.is-reorderable.is-dragging {
    z-index: 2;
    opacity: .48;
    background: var(--surface-2);
    pointer-events: none;
  }
  ```

---

### 4.5 `public/app.js` - Super Admin `/admin` Access & Missing `setShellMode` Crash
- **Problem:**
  1. Lines 91-94: Agar logged-in Super Admin `/admin` par navigate kare, to code `session?.role === 'shop_admin'` check karke direct `renderLogin('shop')` me daal deta hai, super admin dashboard unreachable ho jata hai.
  2. Line 31 & 98: Customer route (`/shop/:shopId`) par session expire hone par 401 aane par `renderLogin()` call hota hai jo `setShellMode(false)` call karta hai. Par customer route par `admin.js` load nahi hota, jisse `ReferenceError: setShellMode is not defined` se page crash ho jata hai.
- **File:** `public/app.js`
- **Fix:**
  1. Safe helper define karo `app.js` me:
     ```javascript
     function setShellMode(on) { document.body.classList.toggle('is-admin', Boolean(on)); }
     ```
  2. Route handling ko order karo:
     ```javascript
     if (session?.role === 'super_admin') { logoutButton.classList.remove('hidden'); await renderSuper(); return; }
     if (isShopAdminRoute) {
       if (session?.role === 'shop_admin') { logoutButton.classList.remove('hidden'); await renderShopAdmin(); }
       else { renderLogin('shop'); }
       return;
     }
     ```

---

## 5. Verification Commands

Har fix apply karne ke baad ye commands run karke verify karein:
```bash
npm test
npm run smoke
npm run test:payments
npm run test:all
```
