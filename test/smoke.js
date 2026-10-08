// End-to-end check against a running local instance with an empty/test database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();
const base = process.env.SMOKE_URL || 'http://127.0.0.1:3000';
const createdShopIds = [];

function pdf(pageCount = 1) {
  const stream = 'BT /F1 12 Tf 20 100 Td (Print Wallah test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${['3 0 R', ...Array.from({ length: pageCount - 1 }, (_, i) => `${6 + i} 0 R`)].join(' ')}] /Count ${pageCount} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 210 297] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from({ length: pageCount - 1 }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 210 297] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'),
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

function client() {
  let cookie = '';
  return async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + '/api' + path, { method, body, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${data.error || data.toString()}`);
    return data;
  };
}
const post = value => ({ method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });

async function main() {
  const superAdmin = client();
  const anonymous = client();
  await assert.rejects(() => anonymous('/super/overview'));
  const login = await superAdmin('/auth/super/login', post({ email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD }));
  assert.equal(login.user.role, 'super_admin');
  assert.equal((await superAdmin('/session')).user.role, 'super_admin', 'login cookie persists for later requests');
  await assert.rejects(() => client()('/auth/super/login', post({ email: process.env.SUPER_ADMIN_EMAIL, password: 'definitely-the-wrong-password' })));
  const shopA = await superAdmin('/super/shops', post({ name: 'Smoke Shop A', ownerName: 'Owner A', phone: '1234567890', address: '1 Test Road', city: 'Test City', adminEmail: `a-${Date.now()}@test.local`, adminPassword: 'shop-admin-password-123', upiId: 'shopa@upi', pricing: { bw_a4: 2 }, printConfig: { paperSizes: ['A4'], paperTypes: ['normal'], color: false, duplex: false, photo: false, defaultPaper: 'A4' } }));
  createdShopIds.push(shopA.shop.id);
  const shopB = await superAdmin('/super/shops', post({ name: 'Smoke Shop B', ownerName: 'Owner B', phone: '1234567891', address: '2 Test Road', city: 'Test City', adminEmail: `b-${Date.now()}@test.local`, adminPassword: 'shop-admin-password-123', upiId: 'shopb@upi', pricing: { bw_a4: 9.5 } }));
  createdShopIds.push(shopB.shop.id);
  assert.ok(shopA.qr.startsWith('data:image/png;base64,'));
  assert.ok(shopA.customerUrl.endsWith(`/shop/${shopA.shop.id}`));
  assert.notEqual(shopA.shop.id, shopB.shop.id);
  const details = await superAdmin(`/super/shops/${shopA.shop.id}`);
  assert.equal(details.shop.name, 'Smoke Shop A');
  assert.equal(details.stats.month_orders, 0);
  assert.equal(details.customerUrl, shopA.customerUrl);
  assert.ok(details.qr.startsWith('data:image/png;base64,'));
  await assert.rejects(() => superAdmin('/super/shops/not-a-shop'));
  assert.equal((await superAdmin(`/shops/${shopA.shop.id}/public`)).shop.pricing.bw_a4, 2);
  assert.deepEqual((await superAdmin(`/shops/${shopA.shop.id}/public`)).shop.printConfig.paperSizes, ['A4']);
  assert.equal((await superAdmin(`/shops/${shopB.shop.id}/public`)).shop.pricing.bw_a4, 9.5);
  await assert.rejects(() => superAdmin('/shops/not-a-shop/public'));

  async function upload(shopId) {
    const form = new FormData();
    form.append('document', new Blob([pdf()], { type: 'application/pdf' }), 'sample.pdf');
    return superAdmin(`/shops/${shopId}/uploads`, { method: 'POST', body: form });
  }
  const fileA = await upload(shopA.shop.id);
  assert.equal(fileA.pages, 1);
  const quote = await superAdmin(`/shops/${shopB.shop.id}/price`, post({ pages: 1, copies: 2, color: false, paperSize: 'A4', paperType: 'normal', duplex: false }));
  assert.equal(quote.total, 19);

  const orderA = await superAdmin(`/shops/${shopA.shop.id}/orders`, post({ uploadToken: fileA.uploadToken, paymentMethod: 'cash', config: { copies: 2, color: false, paperSize: 'A4', paperType: 'normal', duplex: false } }));
  assert.equal(orderA.order.status, 'cash_confirmation_pending');
  const adminA = client();
  const adminLogin = await adminA('/auth/shop/login', post({ email: shopA.shop.adminEmail, password: 'shop-admin-password-123' }));
  assert.equal(adminLogin.user.role, 'shop_admin');
  assert.equal((await adminA('/session')).user.shopId, shopA.shop.id, 'session shape matches the shop-login response');
  const adminB = client();
  await adminB('/auth/shop/login', post({ email: shopB.shop.adminEmail, password: 'shop-admin-password-123' }));
  assert.equal((await adminA('/admin/me')).shop.id, shopA.shop.id);
  assert.equal((await adminA('/admin/overview')).stats.cash_pending, 1);
  const shopSettings = await adminA('/admin/settings', { method: 'PATCH', body: JSON.stringify({ name: 'Smoke Shop A Updated', ownerName: 'Updated Owner', phone: '1234567000', email: 'updated@test.local', address: '2 Updated Road', city: 'Updated City', upiId: 'shopaupdated@upi', upiName: 'Updated Payee', agentName: 'Updated Printer', pricing: { bw_a4: 3 }, printConfig: { paperSizes: ['A4'], paperTypes: ['normal'], color: false, duplex: false, photo: false, defaultPaper: 'A4' }, adminEmail: 'changed@test.local', adminPassword: 'not-a-shop-admin-setting' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(shopSettings.shop.name, 'Smoke Shop A Updated');
  assert.equal(shopSettings.shop.ownerName, 'Updated Owner');
  assert.equal(shopSettings.shop.email, 'updated@test.local');
  assert.equal(shopSettings.shop.city, 'Updated City');
  assert.equal(shopSettings.shop.upiId, 'shopaupdated@upi');
  assert.equal(shopSettings.shop.adminEmail, shopA.shop.adminEmail, 'Shop Settings cannot change admin credentials');
  await assert.rejects(() => adminA('/admin/settings', { method: 'PATCH', body: JSON.stringify({ upiId: 'not-a-valid-upi' }), headers: { 'Content-Type': 'application/json' } }));
  await client()('/auth/shop/login', post({ email: shopA.shop.adminEmail, password: 'shop-admin-password-123' }));
  assert.ok(Array.isArray((await adminA('/admin/analytics?from=2026-01-01&to=2026-12-31')).rows));
  const today = new Date().toISOString().slice(0, 10);
  const sameDayAnalytics = (await adminA(`/admin/analytics?from=${today}&to=${today}`)).rows;
  assert.ok(sameDayAnalytics.some(row => Number(row.orders) > 0), 'analytics end date includes the entire selected day');
  const ordersA = await adminA('/admin/orders');
  assert.equal(ordersA.length, 1);
  assert.equal((await adminB('/admin/orders')).length, 0);
  await assert.rejects(() => adminB(`/admin/orders/${ordersA[0].id}/cash-confirm`, post({})));
  await assert.rejects(() => adminB(`/admin/uploads/${ordersA[0].id}`));
  const before = await adminA('/admin/overview');
  assert.equal(before.stats.queue, 0, 'cash order must not print before confirmation');
  await adminA(`/admin/orders/${ordersA[0].id}/cash-confirm`, post({}));
  const heartbeat = await fetch(`${base}/api/agent/${shopA.shop.id}/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${shopA.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName: 'Smoke agent' }) });
  assert.equal(heartbeat.status, 200);
  const claim = await fetch(`${base}/api/agent/${shopA.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopA.agentToken}` } });
  const claimed = await claim.json();
  assert.equal(claimed.job.order_code, orderA.order.code);
  const document = await fetch(`${base}${claimed.job.downloadUrl}`, { headers: { Authorization: `Bearer ${shopA.agentToken}` } });
  assert.equal(document.status, 200);
  assert.match(Buffer.from(await document.arrayBuffer()).toString('latin1'), /^%PDF-/);
  const completed = await fetch(`${base}/api/agent/${shopA.shop.id}/jobs/${claimed.job.job_id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${shopA.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(completed.status, 200);
  assert.equal((await superAdmin(`/orders/${orderA.order.code}/status`)).order_status, 'completed');

  const bundleUploads = [];
  for (const [name, bytes, mime] of [
    ['bundle-two-pages.pdf', pdf(2), 'application/pdf'],
    ['bundle-one-page.pdf', pdf(1), 'application/pdf'],
    ['bundle-image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64'), 'image/png'],
  ]) {
    const form = new FormData();
    form.append('document', new Blob([bytes], { type: mime }), name);
    bundleUploads.push(await superAdmin(`/shops/${shopA.shop.id}/uploads`, { method: 'POST', body: form }));
  }
  const documentTokens = bundleUploads.map((item) => item.uploadToken);
  const bundleConfig = { mode: 'document', copies: 2, color: false, paperSize: 'A4', paperType: 'normal', duplex: false, pageRange: 'all' };
  const bundleQuote = await superAdmin(`/shops/${shopA.shop.id}/price`, post({ uploadToken: documentTokens[0], documentTokens, config: bundleConfig }));
  assert.equal(bundleQuote.pages, 4, 'bundle quote sums server-detected pages across PDFs and images');
  assert.equal(bundleQuote.total, 24, 'shared copies and the shop rate apply to all bundle pages');
  const bundleOrder = await superAdmin(`/shops/${shopA.shop.id}/orders`, post({ uploadToken: documentTokens[0], documentTokens, paymentMethod: 'cash', config: bundleConfig, expectedAmount: bundleQuote.total }));
  assert.equal(bundleOrder.order.amount, 24);
  assert.equal(bundleOrder.order.fileName, '3 files');
  const bundleAdminOrder = (await adminA('/admin/orders')).find((item) => item.order_code === bundleOrder.order.code);
  assert.deepEqual(bundleAdminOrder.config.documentFiles, bundleUploads.map((item) => item.fileName));
  await adminA(`/admin/orders/${bundleAdminOrder.id}/cash-confirm`, post({}));
  const bundleClaimResponse = await fetch(`${base}/api/agent/${shopA.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopA.agentToken}` } });
  const bundleClaim = await bundleClaimResponse.json();
  assert.equal(bundleClaim.job.order_code, bundleOrder.order.code);
  assert.equal(bundleClaim.job.page_count, 4);
  assert.equal(bundleClaim.job.copies, 2, 'document bundle preserves customer-selected copies');
  const bundleFileResponse = await fetch(`${base}${bundleClaim.job.downloadUrl}`, { headers: { Authorization: `Bearer ${shopA.agentToken}` } });
  assert.equal(bundleFileResponse.status, 200);
  const printableBundle = await PDFDocument.load(Buffer.from(await bundleFileResponse.arrayBuffer()));
  assert.equal(printableBundle.getPageCount(), 4, 'agent downloads a combined PDF containing every selected page');
  const bundleDone = await fetch(`${base}/api/agent/${shopA.shop.id}/jobs/${bundleClaim.job.job_id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${shopA.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(bundleDone.status, 200);

  const fileB = await upload(shopB.shop.id);
  const orderB = await superAdmin(`/shops/${shopB.shop.id}/orders`, post({ uploadToken: fileB.uploadToken, paymentMethod: 'upi', config: { copies: 1, color: false, paperSize: 'A4', paperType: 'normal', duplex: false } }));
  const intent = new URL(orderB.order.upiUrl);
  assert.equal(intent.protocol, 'upi:');
  assert.equal(intent.searchParams.get('pa'), 'shopb@upi');
  assert.equal(intent.searchParams.get('am'), Number(orderB.order.amount).toFixed(2));
  assert.equal((await superAdmin(`/orders/${orderB.order.code}/status`)).payment_status, 'pending');
  const pendingUpi = (await adminB('/admin/orders')).find(o => o.order_code === orderB.order.code);
  await assert.rejects(() => adminA(`/admin/orders/${pendingUpi.id}/payment-verify`, post({ verified: true })), /HTTP 404|HTTP 403/);
  const upiOrder = (await adminB('/admin/orders')).find(o => o.order_code === orderB.order.code);
  assert.equal(upiOrder.payment_reference, null, 'customer reference is optional');
  await adminB(`/admin/orders/${upiOrder.id}/payment-verify`, post({ verified: true }));
  assert.equal((await superAdmin(`/orders/${orderB.order.code}/status`)).payment_status, 'verified');
  const upiJobResponse = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopB.agentToken}` } });
  const upiJob = await upiJobResponse.json();
  const upiResult = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs/${upiJob.job.job_id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${shopB.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(upiResult.status, 200);
  const photoForm = new FormData();
  photoForm.append('document', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'portrait.png');
  const photoUpload = await superAdmin(`/shops/${shopB.shop.id}/uploads`, { method: 'POST', body: photoForm });
  const photoOrder = await superAdmin(`/shops/${shopB.shop.id}/orders`, post({ uploadToken: photoUpload.uploadToken, paymentMethod: 'cash', config: { mode: 'photo', photoSize: 'passport', photoQuantity: 6, copies: 1, color: true, paperSize: 'A4', paperType: 'glossy', orientation: 'portrait' } }));
  const photoAdminOrder = (await adminB('/admin/orders')).find(o => o.order_code === photoOrder.order.code);
  assert.equal(photoAdminOrder.config.photoCapacity, 28);
  await adminB(`/admin/orders/${photoAdminOrder.id}/cash-confirm`, post({}));
  const photoClaimResponse = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopB.agentToken}` } });
  const photoClaim = await photoClaimResponse.json();
  assert.equal(photoClaim.job.copies, 1, 'multi-photo sheet PDF itself contains the sheet count');
  const photoDocument = await fetch(`${base}${photoClaim.job.downloadUrl}`, { headers: { Authorization: `Bearer ${shopB.agentToken}` } });
  assert.equal(photoDocument.status, 200);
  assert.match(Buffer.from(await photoDocument.arrayBuffer()).toString('latin1'), /^%PDF-/, 'agent receives the composed printable photo sheet, not the source image');
  const photoDone = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs/${photoClaim.job.job_id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${shopB.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(photoDone.status, 200);
  await adminB(`/admin/orders/${photoAdminOrder.id}/print-failed`, post({ reason: 'Smoke test retry path' }));
  await adminB(`/admin/orders/${photoAdminOrder.id}/retry-print`, post({}));
  const retryResponse = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopB.agentToken}` } });
  const retryClaim = await retryResponse.json();
  assert.equal(retryClaim.job.order_code, photoOrder.order.code);
  const retryDone = await fetch(`${base}/api/agent/${shopB.shop.id}/jobs/${retryClaim.job.job_id}/result`, { method: 'POST', headers: { Authorization: `Bearer ${shopB.agentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }) });
  assert.equal(retryDone.status, 200);
  const rejectedUpload = await upload(shopB.shop.id);
  const rejectedOrder = await superAdmin(`/shops/${shopB.shop.id}/orders`, post({ uploadToken: rejectedUpload.uploadToken, paymentMethod: 'upi', config: { copies: 1, color: false, paperSize: 'A4', paperType: 'normal', duplex: false } }));
  await superAdmin(`/orders/${rejectedOrder.order.code}/payment-reference`, post({ reference: 'SMOKEREJECT01' }));
  const rejectedAdminOrder = (await adminB('/admin/orders')).find(o => o.order_code === rejectedOrder.order.code);
  await adminB(`/admin/orders/${rejectedAdminOrder.id}/payment-verify`, post({ verified: false }));
  assert.equal((await superAdmin(`/orders/${rejectedOrder.order.code}/status`)).payment_status, 'failed');
  const noUnpaidJob = await (await fetch(`${base}/api/agent/${shopB.shop.id}/jobs`, { headers: { Authorization: `Bearer ${shopB.agentToken}` } })).json();
  assert.equal(noUnpaidJob.job, null, 'a rejected UPI payment never enters the print queue');
  const cancelledUpload = await upload(shopA.shop.id);
  const cancelledOrder = await superAdmin(`/shops/${shopA.shop.id}/orders`, post({ uploadToken: cancelledUpload.uploadToken, paymentMethod: 'cash', config: { copies: 1, color: false, paperSize: 'A4', paperType: 'normal', duplex: false } }));
  const cancelledAdminOrder = (await adminA('/admin/orders')).find(o => o.order_code === cancelledOrder.order.code);
  await adminA(`/admin/orders/${cancelledAdminOrder.id}/cancel`, post({}));
  assert.equal((await superAdmin(`/orders/${cancelledOrder.order.code}/status`)).order_status, 'cancelled');
  const updatedShop = await superAdmin(`/super/shops/${shopA.shop.id}`, { method: 'PATCH', body: JSON.stringify({ phone: '1234567899', pricing: { bw_a4: 3 }, upiId: 'updated@upi' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(updatedShop.shop.phone, '1234567899');
  assert.equal(updatedShop.shop.pricing.bw_a4, 3);
  assert.equal(updatedShop.shop.upiId, 'updated@upi');
  await superAdmin(`/super/shops/${shopA.shop.id}/lock`, post({ locked: true }));
  await assert.rejects(() => superAdmin(`/shops/${shopA.shop.id}/public`));
  await assert.rejects(() => client()('/auth/shop/login', post({ email: shopA.shop.adminEmail, password: 'shop-admin-password-123' })));
  await superAdmin(`/super/shops/${shopA.shop.id}/extend`, post({ days: 30 }));
  assert.equal((await superAdmin(`/shops/${shopA.shop.id}/public`)).shop.id, shopA.shop.id);
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try { await db.query("UPDATE shops SET access_end=now()-interval '1 day' WHERE public_id=$1", [shopA.shop.id]); } finally { await db.end(); }
  await assert.rejects(() => superAdmin(`/shops/${shopA.shop.id}/public`));
  await superAdmin(`/super/shops/${shopA.shop.id}/extend`, post({ days: 30 }));
  assert.equal((await superAdmin(`/shops/${shopA.shop.id}/public`)).shop.id, shopA.shop.id);
  console.log('Smoke check passed: session/auth, shop details/editing, tenant isolation, QR, PDF/image uploads, pricing, cash/UPI intent, optional reference and shop-verified payment queue, photo sheets, lock, expiry and extension.');
}

async function cleanup() {
  if (!createdShopIds.length || !process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try {
    const { rows: files } = await pool.query(`SELECT u.stored_name AS file_name FROM uploads u JOIN shops s ON s.id=u.shop_id WHERE s.public_id=ANY($1::text[]) UNION SELECT o.print_file_name AS file_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE s.public_id=ANY($1::text[]) AND o.print_file_name IS NOT NULL`, [createdShopIds]);
    const uploadDir = path.resolve(process.env.UPLOAD_DIR || './storage');
    for (const file of files) if (path.basename(file.file_name) === file.file_name) fs.rmSync(path.join(uploadDir, file.file_name), { force: true });
    await pool.query('DELETE FROM audit_log WHERE shop_id IN (SELECT id FROM shops WHERE public_id=ANY($1::text[]))', [createdShopIds]);
    await pool.query('DELETE FROM orders WHERE shop_id IN (SELECT id FROM shops WHERE public_id=ANY($1::text[]))', [createdShopIds]);
    await pool.query('DELETE FROM shops WHERE public_id=ANY($1::text[])', [createdShopIds]);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => cleanup().catch(error => { console.error('Smoke cleanup failed:', error.message); process.exitCode = 1; }));
module.exports = { pdf };
