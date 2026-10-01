const crypto = require('node:crypto');

const DEFAULT_PRICING = Object.freeze({ bw_a4: 2, color_a4: 10, bw_a3: 4, color_a3: 20, glossy_a4: 15, photo_sheet: 30 });
// Optional keys. Shops that never set them keep the previous behaviour: glossy A3 uses the A3 colour/B&W rate, an A3 photo sheet uses photo_sheet.
const OPTIONAL_PRICING_KEYS = Object.freeze(['glossy_a3', 'photo_sheet_a3']);
const DEFAULT_PRINT_CONFIG = Object.freeze({ paperSizes: ['A4', 'A3'], paperTypes: ['normal', 'glossy'], color: true, duplex: true, photo: true, defaultPaper: 'A4' });

function isActive(shop, now = new Date()) {
  return !shop.manually_locked && new Date(shop.access_end) > now;
}

function statusOf(shop, now = new Date()) {
  if (shop.manually_locked) return 'locked';
  return new Date(shop.access_end) <= now ? 'expired' : 'active';
}

function calculatePrice({ pricing, pages, copies, color, paperSize, paperType, duplex, photoSheets }) {
  pages = Number(pages); copies = Number(copies);
  if (!Number.isInteger(pages) || pages < 1 || pages > 2000) throw new Error('Invalid page count');
  if (!Number.isInteger(copies) || copies < 1 || copies > 500) throw new Error('Copies must be between 1 and 500');
  const size = String(paperSize || 'A4').toUpperCase();
  const glossyKey = size === 'A4' ? 'glossy_a4' : pricing.glossy_a3 !== undefined && pricing.glossy_a3 !== null && pricing.glossy_a3 !== '' ? 'glossy_a3' : null;
  const key = paperType === 'glossy' && glossyKey ? glossyKey : `${color ? 'color' : 'bw'}_${size.toLowerCase()}`;
  const rate = Number(pricing[key]);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`Pricing is not configured for ${key}`);
  photoSheets = Number(photoSheets || 0);
  if (!Number.isInteger(photoSheets) || photoSheets < 0 || photoSheets > 500) throw new Error('Photo sheets must be between 0 and 500');
  const printablePages = duplex && paperType === 'normal' ? Math.ceil(pages / 2) : pages;
  const base = Number(photoSheets || 0) > 0 ? 0 : printablePages * copies * rate;
  const photoRate = size === 'A3' && pricing.photo_sheet_a3 !== undefined && pricing.photo_sheet_a3 !== null && pricing.photo_sheet_a3 !== '' ? Number(pricing.photo_sheet_a3) : Number(pricing.photo_sheet || 0);
  const photoCharge = photoSheets * photoRate;
  return { rate, printablePages, base: roundMoney(base), photoCharge: roundMoney(photoCharge), total: roundMoney(base + photoCharge) };
}

function roundMoney(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters (I, O, 0, 1); 32 symbols so bytes map without bias
function publicId() { const bytes = crypto.randomBytes(10); return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join(''); }
function orderCode() { return `PR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`; }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

module.exports = { OPTIONAL_PRICING_KEYS, DEFAULT_PRICING, DEFAULT_PRINT_CONFIG, isActive, statusOf, calculatePrice, roundMoney, publicId, orderCode, token, sha256 };
