// End-to-end checks for the UPI/payment state machine, print-queue safety, webhook and LAN behaviour.
// Requires a running server (SMOKE_URL) with PAYMENT_WEBHOOK_SECRET set and the same DATABASE_URL as the server.
require('dotenv').config();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { sign } = require('../src/services/webhook');
const { pdf } = require('./smoke');

const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function client(headers = {}) {
  let cookie = '';
  return async (url, options = {}) => {
    const res = await fetch(base + '/api' + url, { ...options, headers: { ...(options.headers || {}), ...headers, ...(cookie ? { Cookie: cookie } : {}) } });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${options.method || 'GET'} ${url}: HTTP ${res.status} ${data.error || ''}`), { status: res.status, data });
    return data;
  };
}
const rejectsWith = async (promise, status, pattern) => { try { await promise; } catch (e) { assert.equal(e.status, status, e.message); if (pattern) assert.match(e.message, pattern); return; } assert.fail('expected rejection'); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
const ids = [];

async function main() {
  const owner = client();
  await owner('/auth/super/login', json({ email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD }));
  const stamp = Date.now();
  const mk = (n, extra = {}) => owner('/super/shops', json({ name: `Pay Test ${n} ${stamp}`, ownerName: 'Owner', phone: '9999999999', address: '1 Test Road', city: 'Test City', adminEmail: `pay${n}${stamp}@example.test`, adminPassword: 'shop-admin-password-123', ...extra }));
  await rejectsWith(mk(0, { upiId: 'not a upi id' }), 400, /valid UPI/);
  const A = await mk(1, { upiId: 'ShopA@OkBank', upiName: 'Shop A' }), B = await mk(2), nu = await mk(3, { upiId: '' });
  ids.push(A.shop.id, B.shop.id, nu.shop.id);
  assert.equal(A.shop.upiId, 'shopa@okbank', 'UPI ID is normalised');
  const adminA = client(); await adminA('/auth/shop/login', json({ email: A.shop.adminEmail, password: 'shop-admin-password-123' }));
  const adminB = client(); await adminB('/auth/shop/login', json({ email: B.shop.adminEmail, password: 'shop-admin-password-123' }));

  const cust = client();
  const up = async (shop, name = 'doc.pdf', bytes = pdf(3), type = 'application/pdf') => { const f = new FormData(); f.append('document', new Blob([bytes], { type }), name); return cust(`/shops/${shop}/uploads`, { method: 'POST', body: f }); };
  const cfg = { copies: 2, color: false, paperSize: 'A4', paperType: 'normal', duplex: false, pageRange: '1-2' };
  const orderOf = (shop, up_, method, config = cfg, extra = {}) => cust(`/shops/${shop}/orders`, json({ uploadToken: up_.uploadToken, paymentMethod: method, config, ...extra }));

  // Shop URL is case-insensitive; pricing is per shop
  assert.equal((await cust(`/shops/${A.shop.id.toLowerCase()}/public`)).shop.id, A.shop.id);
  // Quote uses the exact order logic: 2 pages x 2 copies x Rs2
  const f1 = await up(A.shop.id);
  const quote = await cust(`/shops/${A.shop.id}/price`, json({ uploadToken: f1.uploadToken, config: cfg }));
  assert.equal(quote.total, 8);
  await rejectsWith(cust(`/shops/${A.shop.id}/price`, json({ uploadToken: f1.uploadToken, config: { ...cfg, pageRange: '1-9' } })), 400, /between 1 and 3/);
  await rejectsWith(cust(`/shops/${A.shop.id}/price`, json({ uploadToken: f1.uploadToken, config: { ...cfg, pageRange: '1-3-5' } })), 400);
  // A shop cannot use another shop's upload
  await rejectsWith(cust(`/shops/${B.shop.id}/price`, json({ uploadToken: f1.uploadToken, config: cfg })), 400, /do(es)? not belong/);

  // UPI order: server amount, intent, QR, pending_payment; browser cannot inject an amount
  const o1 = await orderOf(A.shop.id, f1, 'upi', cfg, { amount: 1, price: 1 });
  assert.equal(o1.order.status, 'pending_payment');
  assert.equal(o1.order.amount, 8);
  const uri = new URL(o1.order.upi.uri);
  assert.equal(uri.searchParams.get('pa'), 'shopa@okbank'); assert.equal(uri.searchParams.get('am'), '8.00');
  assert.equal(uri.searchParams.get('tr'), o1.order.code); assert.equal(uri.searchParams.get('cu'), 'INR'); assert.equal(uri.searchParams.get('pn'), 'Shop A');
  assert.match(o1.order.upi.qr, /^data:image\/png;base64,/);
  // Double tap / refresh: same order is returned, not a second order or an error
  const again = await orderOf(A.shop.id, f1, 'upi');
  assert.equal(again.order.code, o1.order.code); assert.equal(again.resumed, true);
  const resumed = await cust(`/orders/${o1.order.code}`);
  assert.equal(resumed.order.upi.uri, o1.order.upi.uri, 'checkout can be resumed after refresh');
  assert.equal((await adminA('/admin/orders')).length, 1);
  assert.equal((await adminA('/admin/overview')).stats.awaiting_payment, 1);
  // Not printable before payment
  assert.equal((await adminA('/admin/overview')).stats.queue, 0);
  // Claim with bad and good reference
  await rejectsWith(cust(`/orders/${o1.order.code}/payment-claim`, json({ reference: 'bad ref!' })), 400);
  await cust(`/orders/${o1.order.code}/payment-claim`, json({ reference: '412345678901' }));
  assert.equal((await cust(`/orders/${o1.order.code}/status`)).order_status, 'payment_review');
  await rejectsWith(cust(`/orders/${o1.order.code}/switch-cash`, json({})), 409);
  await rejectsWith(cust(`/orders/${o1.order.code}/cancel`, json({})), 409);
  const row = (await adminA('/admin/orders'))[0];
  assert.equal(row.payment_reference, '412345678901');
  await rejectsWith(adminB(`/admin/orders/${row.id}/payment-verify`, json({ verified: true })), 404);
  await adminA(`/admin/orders/${row.id}/payment-verify`, json({ verified: true }));
  assert.equal((await cust(`/orders/${o1.order.code}/status`)).order_status, 'print_queued');
  await rejectsWith(cust(`/orders/${o1.order.code}/payment-claim`, json({})), 409);

  // Cancel a queued order: the job must disappear so the agent cannot print it
  await adminA(`/admin/orders/${row.id}/cancel`, json({}));
  const agent = (shop, tokenValue) => (p, o = {}) => fetch(`${base}/api/agent/${shop}${p}`, { ...o, headers: { Authorization: `Bearer ${tokenValue}`, 'Content-Type': 'application/json' } }).then((r) => r.json());
  const agA = agent(A.shop.id, A.agentToken);
  assert.equal((await agA('/jobs')).job, null, 'cancelled order is never claimed by the agent');

  // Cash path, then retry-print gets a fresh job id
  const f2 = await up(A.shop.id);
  const o2 = await orderOf(A.shop.id, f2, 'cash');
  assert.equal(o2.order.upi, null); assert.equal(o2.order.status, 'cash_confirmation_pending');
  const r2 = (await adminA('/admin/orders')).find((o) => o.order_code === o2.order.code);
  await rejectsWith(adminA(`/admin/orders/${r2.id}/complete`, json({})), 409);
  await adminA(`/admin/orders/${r2.id}/cash-confirm`, json({}));
  const c1 = await agA('/jobs'); assert.equal(c1.job.order_code, o2.order.code);
  await agA(`/jobs/${c1.job.job_id}/result`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
  await adminA(`/admin/orders/${r2.id}/print-failed`, json({ reason: 'paper jam' }));
  await adminA(`/admin/orders/${r2.id}/retry-print`, json({}));
  const c2 = await agA('/jobs'); assert.equal(c2.job.order_code, o2.order.code);
  assert.notEqual(c2.job.job_id, c1.job.job_id, 'retry issues a new job id so the agent journal cannot swallow it');
  await agA(`/jobs/${c2.job.job_id}/result`, { method: 'POST', body: JSON.stringify({ status: 'failed', error: 'Printer offline' }) });
  const failed = (await adminA('/admin/orders')).find((o) => o.order_code === o2.order.code);
  assert.equal(failed.order_status, 'failed'); assert.equal(failed.print_error, 'Printer offline');

  // Drag-reordering the persisted shop queue changes which job the agent claims next.
  const queueFileA = await up(A.shop.id); const queuedOrderA = await orderOf(A.shop.id, queueFileA, 'cash');
  const queueFileB = await up(A.shop.id); const queuedOrderB = await orderOf(A.shop.id, queueFileB, 'cash');
  const queueRowA = (await adminA('/admin/orders')).find((o) => o.order_code === queuedOrderA.order.code);
  const queueRowB = (await adminA('/admin/orders')).find((o) => o.order_code === queuedOrderB.order.code);
  await adminA(`/admin/orders/${queueRowA.id}/cash-confirm`, json({}));
  await adminA(`/admin/orders/${queueRowB.id}/cash-confirm`, json({}));
  const queued = await adminA('/admin/print-queue');
  assert.deepEqual(queued.map((o) => o.order_code), [queuedOrderA.order.code, queuedOrderB.order.code]);
  const reorderedIds = queued.map((o) => o.id).reverse();
  await rejectsWith(adminA('/admin/print-queue', { ...json({ orderIds: [reorderedIds[0], reorderedIds[0]] }), method: 'PATCH' }), 400);
  await rejectsWith(adminB('/admin/print-queue', { ...json({ orderIds: reorderedIds }), method: 'PATCH' }), 409);
  await adminA('/admin/print-queue', { ...json({ orderIds: reorderedIds }), method: 'PATCH' });
  assert.deepEqual((await adminA('/admin/print-queue')).map((o) => o.order_code), [queuedOrderB.order.code, queuedOrderA.order.code]);
  assert.equal((await cust(`/orders/${queuedOrderB.order.code}/status`)).ahead, 0);
  assert.equal((await cust(`/orders/${queuedOrderA.order.code}/status`)).ahead, 1);
  const prioritized = await agA('/jobs');
  assert.equal(prioritized.job.order_code, queuedOrderB.order.code);
  await agA(`/jobs/${prioritized.job.job_id}/result`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
  const next = await agA('/jobs');
  assert.equal(next.job.order_code, queuedOrderA.order.code);
  await agA(`/jobs/${next.job.job_id}/result`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });

  // Customer cancels / switches
  const f3 = await up(A.shop.id); const o3 = await orderOf(A.shop.id, f3, 'upi');
  await cust(`/orders/${o3.order.code}/switch-cash`, json({}));
  assert.equal((await cust(`/orders/${o3.order.code}/status`)).order_status, 'cash_confirmation_pending');
  const f4 = await up(A.shop.id); const o4 = await orderOf(A.shop.id, f4, 'upi');
  await cust(`/orders/${o4.order.code}/cancel`, json({}));
  assert.equal((await cust(`/orders/${o4.order.code}/status`)).order_status, 'cancelled');
  await cust(`/orders/${o4.order.code}/cancel`, json({}));

  // Missing UPI ID: UPI order is refused; cash still works
  const f5 = await up(nu.shop.id);
  await rejectsWith(orderOf(nu.shop.id, f5, 'upi'), 400, /not configured/);
  assert.equal((await cust(`/shops/${nu.shop.id}/public`)).shop.upiConfigured, false);
  await orderOf(nu.shop.id, f5, 'cash');

  // Webhook: signature, amount check, idempotency
  const f6 = await up(A.shop.id); const o6 = await orderOf(A.shop.id, f6, 'upi');
  const hook = (body, sig) => { const raw = JSON.stringify(body); return fetch(`${base}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PW-Signature': sig ?? sign(raw) }, body: raw }); };
  assert.equal((await hook({ eventId: `e1-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8 }, 'sha256=00')).status, 401);
  assert.equal((await hook({ eventId: `missing-currency-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8 })).status, 400);
  assert.equal((await hook({ eventId: `non-numeric-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: true, currency: 'INR' })).status, 400);
  assert.equal((await hook({ eventId: `too-precise-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8.001, currency: 'INR' })).status, 400);
  assert.equal((await hook({ eventId: `x${'x'.repeat(200)}-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8, currency: 'INR' })).status, 400);
  assert.equal((await hook({ eventId: `e2-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 1, currency: 'INR' })).status, 422);
  assert.equal((await cust(`/orders/${o6.order.code}/status`)).payment_status, 'pending', 'wrong amount never verifies');
  const okHook = await hook({ eventId: `e3-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8, currency: 'INR', providerPaymentId: 'PAY123456' });
  assert.equal((await okHook.json()).outcome, 'verified');
  assert.equal((await (await hook({ eventId: `e3-${stamp}`, orderCode: o6.order.code, status: 'paid', amount: 8, currency: 'INR' })).json()).duplicate, true);
  assert.equal((await cust(`/orders/${o6.order.code}/status`)).order_status, 'print_queued');
  assert.equal((await hook({ eventId: `e4-${stamp}`, orderCode: 'PR-NOPE', status: 'paid', amount: 8, currency: 'INR' })).status, 404);

  // Multi-photo sheet: two photos with quantities share sheets
  const pa = await up(B.shop.id, 'a.png', PNG, 'image/png'), pb = await up(B.shop.id, 'b.png', PNG, 'image/png');
  const photoCfg = { mode: 'photo', paperSize: 'A4', paperType: 'glossy', photoSize: '4x6', photoFit: 'cover', orientation: 'portrait', color: true, photoItems: [{ uploadToken: pa.uploadToken, quantity: 3 }, { uploadToken: pb.uploadToken, quantity: 2 }], photoQuantity: 5 };
  const pq = await cust(`/shops/${B.shop.id}/price`, json({ uploadToken: pa.uploadToken, config: photoCfg }));
  assert.equal(pq.photoQuantity, 5); assert.equal(pq.sheets, Math.ceil(5 / pq.photoCapacity)); assert.equal(pq.total, 30 * pq.sheets);
  const po = await orderOf(B.shop.id, pa, 'cash', photoCfg);
  assert.equal(po.order.amount, pq.total);
  const prow = (await adminB('/admin/orders')).find((o) => o.order_code === po.order.code);
  assert.equal(prow.config.photoQuantity, 5);
  await adminB(`/admin/orders/${prow.id}/cash-confirm`, json({}));
  const agB = agent(B.shop.id, B.agentToken); const pj = await agB('/jobs');
  const file = await fetch(`${base}${pj.job.downloadUrl}`, { headers: { Authorization: `Bearer ${B.agentToken}` } });
  assert.match(Buffer.from(await file.arrayBuffer()).toString('latin1'), /^%PDF-/);
  await rejectsWith(cust(`/shops/${B.shop.id}/price`, json({ uploadToken: pa.uploadToken, config: { ...photoCfg, photoItems: [{ uploadToken: pa.uploadToken, quantity: 1 }, { uploadToken: pa.uploadToken, quantity: 1 }] } })), 400, /twice/);
  // Oversized image dimensions are rejected before rendering
  const huge = Buffer.from(PNG); huge.writeUInt32BE(20000, 16); huge.writeUInt32BE(20000, 20);
  await rejectsWith(up(B.shop.id, 'huge.png', huge, 'image/png'), 400, /too large/);
  // Corrupt PDF
  await rejectsWith(up(B.shop.id, 'bad.pdf', Buffer.from('%PDF-1.4 garbage'), 'application/pdf'), 400, /Could not read/);

  // LAN: QR/shop links use the address the browser used instead of localhost (unit-level check of the resolver; the QR endpoint uses it)
  const { baseUrl } = require('../src/services/network');
  const fake = (host) => ({ protocol: 'http', get: () => host });
  const saved = { app: process.env.APP_URL, env: process.env.NODE_ENV };
  process.env.APP_URL = 'http://localhost:3000'; process.env.NODE_ENV = 'development';
  assert.equal(baseUrl(fake('192.168.1.50:3100')), 'http://192.168.1.50:3100');
  assert.equal(baseUrl(fake('localhost:3100')), 'http://localhost:3000');
  process.env.APP_URL = 'https://print.example.com'; assert.equal(baseUrl(fake('192.168.1.50:3100')), 'https://print.example.com');
  process.env.APP_URL = 'http://localhost:3000'; process.env.NODE_ENV = 'production'; assert.equal(baseUrl(fake('192.168.1.50:3100')), 'http://localhost:3000', 'production always honours APP_URL');
  process.env.APP_URL = saved.app || ''; process.env.NODE_ENV = saved.env || '';
  const details = await owner(`/super/shops/${A.shop.id}`);
  assert.match(details.customerUrl, new RegExp(`/shop/${A.shop.id}$`));
  assert.ok(details.qr.startsWith('data:image/'));

  // Password change ends the old admin session; duplicate admin email is a clear 409
  await owner(`/super/shops/${B.shop.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: 'another-password-456' }) });
  await rejectsWith(adminB('/admin/orders'), 401);
  await rejectsWith(owner(`/super/shops/${B.shop.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminEmail: A.shop.adminEmail }) }), 409, /already uses/);
  await rejectsWith(owner(`/super/shops/${B.shop.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upiId: 'bad upi' }) }), 400);
  // Malformed and unauthenticated requests
  const bad = await fetch(base + '/api/shops/' + A.shop.id + '/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }); assert.equal(bad.status, 400);
  assert.equal((await fetch(base + '/api/super/shops')).status, 401);
  assert.equal((await fetch(base + '/api/admin/orders')).status, 401);
  assert.equal((await fetch(base + '/api/shops/NOPE12345/public')).status, 404);
  console.log('Payments check passed: UPI states, idempotency, queue reorder priority and customer positions, print-agent claims, webhook, retry ids, multi-photo, validation, sessions.');
}

async function cleanup() {
  if (!ids.length) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try {
    const dir = path.resolve(process.env.UPLOAD_DIR || './storage');
    const { rows } = await pool.query(`SELECT u.stored_name f FROM uploads u JOIN shops s ON s.id=u.shop_id WHERE s.public_id=ANY($1) UNION SELECT o.print_file_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE s.public_id=ANY($1) AND o.print_file_name IS NOT NULL`, [ids]);
    for (const r of rows) if (r.f && path.basename(r.f) === r.f) fs.rmSync(path.join(dir, r.f), { force: true });
    await pool.query("DELETE FROM payment_events WHERE event_id LIKE 'e_-%' AND order_code IS NOT NULL AND order_code LIKE 'PR-%' AND created_at > now() - interval '1 hour'");
    await pool.query('DELETE FROM payment_events WHERE order_code IN (SELECT order_code FROM orders WHERE shop_id IN (SELECT id FROM shops WHERE public_id=ANY($1)))', [ids]);
    await pool.query('DELETE FROM audit_log WHERE shop_id IN (SELECT id FROM shops WHERE public_id=ANY($1))', [ids]);
    await pool.query('DELETE FROM orders WHERE shop_id IN (SELECT id FROM shops WHERE public_id=ANY($1))', [ids]);
    await pool.query('DELETE FROM shops WHERE public_id=ANY($1)', [ids]);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => cleanup().catch((e) => { console.error('cleanup failed', e.message); process.exitCode = 1; }));
