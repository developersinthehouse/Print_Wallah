const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

async function lockExpiredShops({ shopRepository, now = () => new Date() }) {
  if (
    !shopRepository ||
    typeof shopRepository.findExpiredShops !== 'function' ||
    typeof shopRepository.lockIfExpired !== 'function'
  ) {
    throw new TypeError('Shop repository must provide findExpiredShops and lockIfExpired');
  }

  const currentTime = now();
  const expiredShops = await shopRepository.findExpiredShops(currentTime);
  const lockResults = await Promise.all(
    expiredShops.map((shop) => shopRepository.lockIfExpired(String(shop.id), currentTime)),
  );
  return lockResults.filter(Boolean).length;
}

function startExpiryMonitor({
  shopRepository,
  intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  now = () => new Date(),
  logger = console,
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new RangeError('Expiry sweep interval must be at least 1000 milliseconds');
  }

  let running = false;
  const runSweep = async () => {
    if (running) return;
    running = true;
    try {
      const lockedCount = await lockExpiredShops({ shopRepository, now });
      if (lockedCount > 0) {
        logger.info(`Locked ${lockedCount} expired shop subscription(s)`);
      }
    } catch (error) {
      logger.error('Subscription expiry sweep failed', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void runSweep(); }, intervalMs);
  timer.unref?.();
  void runSweep();
  return () => clearInterval(timer);
}

function calculateRenewalExpiry(currentExpiry, now, durationDays) {
  if (!Number.isInteger(durationDays) || durationDays < 1) {
    throw new RangeError('Subscription duration must be a positive whole number of days');
  }

  const currentTime = new Date(now);
  if (Number.isNaN(currentTime.getTime())) {
    throw new TypeError('Renewal time must be a valid date');
  }

  const existingExpiry = new Date(currentExpiry);
  const baseTime = Number.isNaN(existingExpiry.getTime())
    ? currentTime.getTime()
    : Math.max(currentTime.getTime(), existingExpiry.getTime());
  return new Date(baseTime + durationDays * DAY_MS);
}

module.exports = {
  calculateRenewalExpiry,
  lockExpiredShops,
  startExpiryMonitor,
};