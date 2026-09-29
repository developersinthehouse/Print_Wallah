function createSubscriptionCheck({
  shopRepository,
  now = () => new Date(),
  getAuthenticatedShopId = (request) => request.auth?.shopId,
}) {
  if (
    !shopRepository ||
    typeof shopRepository.findById !== 'function' ||
    typeof shopRepository.lockIfExpired !== 'function'
  ) {
    throw new TypeError('Shop repository must provide findById and lockIfExpired');
  }

  return async function requireActiveSubscription(request, response, next) {
    const shopId = getAuthenticatedShopId(request);
    if (!shopId) {
      return response.status(401).json({ error: 'SHOP_AUTH_REQUIRED' });
    }

    try {
      const shop = await shopRepository.findById(String(shopId));
      if (!shop) {
        return response.status(404).json({ error: 'SHOP_NOT_FOUND' });
      }

      const expiry = new Date(shop.subscription_expiry_date);
      const currentTime = now();
      const expired =
        shop.subscription_status === 'EXPIRED' ||
        Number.isNaN(expiry.getTime()) ||
        expiry.getTime() <= currentTime.getTime();

      if (expired) {
        await shopRepository.lockIfExpired(String(shopId), currentTime);
        return response.status(403).json({
          error: 'SUBSCRIPTION_EXPIRED',
          message: 'Subscription Expired',
        });
      }

      if (shop.subscription_status && shop.subscription_status !== 'ACTIVE') {
        return response.status(403).json({ error: 'SUBSCRIPTION_LOCKED' });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { createSubscriptionCheck };