const crypto = require('node:crypto');
const express = require('express');
const { calculateRenewalExpiry } = require('./subscriptionEngine');

function verifySignature(rawBody, signatureHeader, secret) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader || '');
  if (!match) return false;

  const providedSignature = Buffer.from(match[1], 'hex');
  const expectedSignature = crypto.createHmac('sha256', secret).update(rawBody).digest();
  return crypto.timingSafeEqual(providedSignature, expectedSignature);
}

function createSubscriptionRouter({
  shopRepository,
  paymentWebhookSecret,
  planDurationsDays,
  now = () => new Date(),
}) {
  if (
    !shopRepository ||
    typeof shopRepository.findById !== 'function' ||
    typeof shopRepository.applyVerifiedRenewal !== 'function'
  ) {
    throw new TypeError('Shop repository must provide findById and applyVerifiedRenewal');
  }
  if (typeof paymentWebhookSecret !== 'string' || Buffer.byteLength(paymentWebhookSecret) < 32) {
    throw new TypeError('Payment webhook secret must contain at least 32 bytes');
  }
  if (
    !planDurationsDays ||
    Object.keys(planDurationsDays).length === 0 ||
    Object.values(planDurationsDays).some((days) => !Number.isInteger(days) || days < 1)
  ) {
    throw new TypeError('Configure at least one plan with a positive whole-number duration in days');
  }

  const router = express.Router();
  router.post('/payment-callback', express.raw({ type: 'application/json', limit: '16kb' }), async (request, response, next) => {
    if (!Buffer.isBuffer(request.body)) {
      return response.status(400).json({ error: 'INVALID_PAYMENT_CALLBACK' });
    }
    if (!verifySignature(request.body, request.get('x-payment-signature'), paymentWebhookSecret)) {
      return response.status(401).json({ error: 'INVALID_PAYMENT_SIGNATURE' });
    }

    let event;
    try {
      event = JSON.parse(request.body.toString('utf8'));
    } catch {
      return response.status(400).json({ error: 'INVALID_PAYMENT_CALLBACK' });
    }

    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return response.status(400).json({ error: 'INVALID_PAYMENT_CALLBACK' });
    }

    if (event.event !== 'payment.captured' || event.status !== 'PAID') {
      return response.json({ received: true, ignored: true });
    }
    if (
      typeof event.paymentId !== 'string' ||
      event.paymentId.length < 1 ||
      event.paymentId.length > 200 ||
      typeof event.shopId !== 'string' ||
      event.shopId.length < 1 ||
      event.shopId.length > 128 ||
      typeof event.planId !== 'string' ||
      !Object.hasOwn(planDurationsDays, event.planId)
    ) {
      return response.status(400).json({ error: 'INVALID_PAYMENT_CALLBACK' });
    }

    try {
      const shopId = event.shopId;
      const shop = await shopRepository.findById(shopId);
      if (!shop) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }

      const renewedAt = now();
      const newExpiry = calculateRenewalExpiry(
        shop.subscription_expiry_date,
        renewedAt,
        planDurationsDays[event.planId],
      );
      const result = await shopRepository.applyVerifiedRenewal({
        shopId,
        paymentId: event.paymentId,
        planId: event.planId,
        expectedExpiry: shop.subscription_expiry_date ?? null,
        newExpiry,
        renewedAt,
      });

      if (!result) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }
      if (result.conflict) {
        return response.status(409).json({ error: 'SUBSCRIPTION_UPDATE_CONFLICT' });
      }

      const subscriptionExpiryDate = result.subscriptionExpiryDate || newExpiry;
      return response.json({
        received: true,
        duplicate: Boolean(result.duplicate),
        subscription_expiry_date: new Date(subscriptionExpiryDate).toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createSubscriptionRouter };