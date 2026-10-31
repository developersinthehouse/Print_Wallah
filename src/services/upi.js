const QRCode = require('qrcode');

// UPI virtual payment address: handle@psp. Handle allows letters, digits, dot, hyphen, underscore.
const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

function normalizeUpiId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return id || null;
}
function isValidUpiId(value) { return typeof value === 'string' && UPI_ID.test(value); }

// Order references are used as the UPI transaction reference (tr) and in the payment note.
const ORDER_REF = /^[A-Za-z0-9][A-Za-z0-9-]{2,34}$/;

// Builds the standard NPCI UPI deep link. Amount always comes from the server-calculated order.
// Values are percent-encoded (spaces as %20, never "+"); the "@" in the payee address is kept literal, exactly as in the
// NPCI linking examples, because it is always valid in a query string and some apps match the raw VPA text.
function buildUpiUri({ upiId, payeeName, amount, orderCode }) {
  if (!isValidUpiId(upiId)) throw new Error('Shop UPI ID is not valid');
  const am = Number(amount);
  if (!Number.isFinite(am) || am <= 0 || am > 100000 || Number(am.toFixed(2)) <= 0) throw new Error('Order amount is not payable through UPI');
  if (!ORDER_REF.test(String(orderCode ?? ''))) throw new Error('Order reference is not valid for UPI');
  const name = String(payeeName || 'Print Shop').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Print Shop';
  const enc = (value) => encodeURIComponent(value);
  const params = [
    ['pa', enc(upiId).replace(/%40/g, '@')], ['pn', enc(name)], ['am', am.toFixed(2)], ['cu', 'INR'],
    ['tr', enc(orderCode)], ['tn', enc(`Print order ${orderCode}`)],
  ];
  return 'upi://pay?' + params.map(([k, v]) => `${k}=${v}`).join('&');
}

async function upiQr(uri) { return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 360 }); }

module.exports = { normalizeUpiId, isValidUpiId, buildUpiUri, upiQr };
