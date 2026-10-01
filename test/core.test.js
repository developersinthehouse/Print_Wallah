const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePrice, isActive, statusOf, sha256 } = require('../src/services/core');

const rates = { bw_a4: 2, color_a4: 10, bw_a3: 4, color_a3: 20, glossy_a4: 15, photo_sheet: 30 };

test('price quote uses a shop rate and rounds to cents', () => {
  const result = calculatePrice({ pricing: rates, pages: 3, copies: 2, color: false, paperSize: 'A4', paperType: 'normal', duplex: false });
  assert.deepEqual(result, { rate: 2, printablePages: 3, base: 12, photoCharge: 0, total: 12 });
});

test('duplex charges configured rate per physical sheet', () => {
  const result = calculatePrice({ pricing: rates, pages: 3, copies: 1, color: false, paperSize: 'A4', paperType: 'normal', duplex: true });
  assert.equal(result.printablePages, 2);
  assert.equal(result.total, 4);
});

test('photo mode charges complete photo sheets using its own shop rate', () => {
  const result = calculatePrice({ pricing: rates, pages: 1, copies: 2, color: true, paperSize: 'A4', paperType: 'glossy', duplex: false, photoSheets: 2 });
  assert.equal(result.base, 0);
  assert.equal(result.photoCharge, 60);
  assert.equal(result.total, 60);
});

test('shop status prioritizes manual lock, then expiry', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  assert.equal(statusOf({ manually_locked: true, access_end: '2026-10-10T00:00:00Z' }, now), 'locked');
  assert.equal(statusOf({ manually_locked: false, access_end: '2026-09-29T00:00:00Z' }, now), 'expired');
  assert.equal(statusOf({ manually_locked: false, access_end: '2026-10-01T00:00:00Z' }, now), 'active');
  assert.equal(isActive({ manually_locked: false, access_end: '2026-10-01T00:00:00Z' }, now), true);
});

test('quote rejects invalid quantities and unconfigured price keys', () => {
  assert.throws(() => calculatePrice({ pricing: rates, pages: 1, copies: 0, color: false, paperSize: 'A4', paperType: 'normal' }), /Copies/);
  assert.throws(() => calculatePrice({ pricing: rates, pages: 1, copies: 1, color: true, paperSize: 'Letter', paperType: 'normal' }), /not configured/);
});

test('agent token hashes are stable SHA-256 digests', () => {
  assert.equal(sha256('test-token').length, 64);
  assert.equal(sha256('test-token'), sha256('test-token'));
});

// ---- UPI, network and webhook helpers
const { buildUpiUri, isValidUpiId, normalizeUpiId } = require('../src/services/upi');
const { sign, verifySignature } = require('../src/services/webhook');
const { baseUrl, isLocalHost } = require('../src/services/network');

test('UPI ids are validated and normalised', () => {
  assert.equal(normalizeUpiId('  Shop@OkBank '), 'shop@okbank');
  assert.equal(normalizeUpiId('   '), null);
  for (const ok of ['shop@upi', 'shop.name-1@okhdfcbank', '9876543210@paytm']) assert.equal(isValidUpiId(ok), true, ok);
  for (const bad of ['', 'shop', 'a@b', 'sh op@upi', 'shop@', '@upi', 'shop@@upi', 'shop@up!']) assert.equal(isValidUpiId(bad), false, bad);
});

test('UPI deep link carries the shop id, exact amount and order reference', () => {
  const uri = new URL(buildUpiUri({ upiId: 'shop@okbank', payeeName: 'Ram & Sons', amount: 12.5, orderCode: 'PR-ABC' }));
  assert.equal(uri.protocol, 'upi:');
  assert.equal(uri.searchParams.get('pa'), 'shop@okbank');
  assert.equal(uri.searchParams.get('pn'), 'Ram & Sons');
  assert.equal(uri.searchParams.get('am'), '12.50');
  assert.equal(uri.searchParams.get('cu'), 'INR');
  assert.equal(uri.searchParams.get('tr'), 'PR-ABC');
  assert.throws(() => buildUpiUri({ upiId: 'bad id', amount: 5, orderCode: 'X' }), /not valid/);
  assert.throws(() => buildUpiUri({ upiId: 'ab@upi', amount: 0, orderCode: 'X' }), /not payable/);
  assert.throws(() => buildUpiUri({ upiId: 'ab@upi', amount: 'abc', orderCode: 'X' }), /not payable/);
});

test('webhook signatures use HMAC and reject tampering', () => {
  const secret = 'x'.repeat(32), body = Buffer.from('{"eventId":"1"}');
  const good = sign(body, secret);
  assert.equal(verifySignature(body, good, secret), true);
  assert.equal(verifySignature(Buffer.from('{"eventId":"2"}'), good, secret), false);
  assert.equal(verifySignature(body, 'sha256=00', secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, good, ''), false);
});

test('shop links use the address the browser used when APP_URL points at localhost', () => {
  const saved = { app: process.env.APP_URL, env: process.env.NODE_ENV };
  const req = (host) => ({ protocol: 'http', get: () => host });
  try {
    process.env.NODE_ENV = 'development'; process.env.APP_URL = 'http://localhost:3000';
    assert.equal(baseUrl(req('192.168.1.20:3000')), 'http://192.168.1.20:3000');
    assert.equal(baseUrl(req('localhost:3000')), 'http://localhost:3000');
    process.env.APP_URL = 'https://print.example.com/'; assert.equal(baseUrl(req('192.168.1.20:3000')), 'https://print.example.com');
    process.env.NODE_ENV = 'production'; process.env.APP_URL = 'http://localhost:3000'; assert.equal(baseUrl(req('192.168.1.20:3000')), 'http://localhost:3000');
    assert.equal(isLocalHost('127.0.0.1:3000') && isLocalHost('localhost') && !isLocalHost('192.168.1.2:3000'), true);
  } finally { process.env.APP_URL = saved.app || ''; process.env.NODE_ENV = saved.env || ''; }
});

test('optional A3 glossy and photo rates fall back to previous behaviour when unset', () => {
  const base = { bw_a4: 2, color_a4: 10, bw_a3: 4, color_a3: 20, glossy_a4: 15, photo_sheet: 30 };
  assert.equal(calculatePrice({ pricing: base, pages: 1, copies: 1, color: true, paperSize: 'A3', paperType: 'glossy' }).total, 20);
  assert.equal(calculatePrice({ pricing: { ...base, glossy_a3: 35 }, pages: 1, copies: 1, color: true, paperSize: 'A3', paperType: 'glossy' }).total, 35);
  assert.equal(calculatePrice({ pricing: base, pages: 1, copies: 2, color: true, paperSize: 'A3', paperType: 'glossy', photoSheets: 2 }).photoCharge, 60);
  assert.equal(calculatePrice({ pricing: { ...base, photo_sheet_a3: 55 }, pages: 1, copies: 2, color: true, paperSize: 'A3', paperType: 'glossy', photoSheets: 2 }).photoCharge, 110);
});
