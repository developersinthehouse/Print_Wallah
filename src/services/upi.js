const QRCode = require('qrcode');

// UPI virtual payment address: handle@psp. Handle allows letters, digits, dot, hyphen, underscore.
const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;

function normalizeUpiId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return id || null;
}
function isValidUpiId(value) { return typeof value === 'string' && UPI_ID.test(value); }

// Builds the standard NPCI UPI deep link. Amount always comes from the server-calculated order.
function buildUpiUri({ upiId, payeeName, amount, orderCode }) {
  if (!isValidUpiId(upiId)) throw new Error('Shop UPI ID is not valid');
  const am = Number(amount);
  if (!Number.isFinite(am) || am <= 0 || am > 100000) throw new Error('Order amount is not payable through UPI');
  const params = [
    ['pa', upiId], ['pn', String(payeeName || '').slice(0, 60)], ['am', am.toFixed(2)], ['cu', 'INR'],
    ['tr', orderCode], ['tn', `Print order ${orderCode}`],
  ];
  return 'upi://pay?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function upiQr(uri) { return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 360 }); }

module.exports = { normalizeUpiId, isValidUpiId, buildUpiUri, upiQr };
