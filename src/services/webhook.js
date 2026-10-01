const crypto = require('node:crypto');

// Generic signed payment-confirmation contract for a payment provider or bank bridge.
// Disabled unless PAYMENT_WEBHOOK_SECRET is set. Signature: header X-PW-Signature = "sha256=" + hex(HMAC_SHA256(secret, rawBody)).
function webhookEnabled() { return String(process.env.PAYMENT_WEBHOOK_SECRET || '').length >= 24; }

function sign(rawBody, secret = process.env.PAYMENT_WEBHOOK_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(rawBody, header, secret = process.env.PAYMENT_WEBHOOK_SECRET) {
  if (!secret || !header) return false;
  const expected = Buffer.from(sign(rawBody, secret));
  const given = Buffer.from(String(header));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { webhookEnabled, sign, verifySignature };
