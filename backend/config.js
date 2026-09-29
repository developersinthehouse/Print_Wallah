const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

function requiredSecret(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

function parsePlanDurations(value) {
  const plans = {};
  for (const item of String(value || '').split(',').filter(Boolean)) {
    const [planId, durationText, ...extra] = item.trim().split(':');
    const durationDays = Number(durationText);
    if (
      extra.length > 0 ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(planId || '') ||
      !Number.isInteger(durationDays) ||
      durationDays < 1 ||
      Object.hasOwn(plans, planId)
    ) {
      throw new Error('SUBSCRIPTION_PLANS must use unique planId:wholeDays entries');
    }
    plans[planId] = durationDays;
  }
  if (Object.keys(plans).length === 0) {
    throw new Error('SUBSCRIPTION_PLANS must configure at least one plan');
  }
  return plans;
}

function loadConfiguration(environment = process.env) {
  const port = Number(environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port');
  }
  const databaseSsl = environment.DATABASE_SSL || 'false';
  if (!['false', 'require'].includes(databaseSsl)) {
    throw new Error('DATABASE_SSL must be false or require');
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(environment.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname) {
      throw new Error('Unsupported database URL');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  let onboardingUrl;
  try {
    onboardingUrl = new URL(environment.PRINT_WALLAH_ONBOARDING_URL);
    if (!['http:', 'https:'].includes(onboardingUrl.protocol)) throw new Error('Unsupported URL protocol');
  } catch {
    throw new Error('PRINT_WALLAH_ONBOARDING_URL must be an absolute HTTP(S) URL');
  }

  const shopJwtSecret = requiredSecret(environment, 'SHOP_JWT_SECRET');
  const superAdminJwtSecret = requiredSecret(environment, 'SUPER_ADMIN_JWT_SECRET');
  const paymentWebhookSecret = requiredSecret(environment, 'PAYMENT_WEBHOOK_SECRET');
  if (new Set([shopJwtSecret, superAdminJwtSecret, paymentWebhookSecret]).size !== 3) {
    throw new Error('Shop, super-admin, and payment webhook secrets must be distinct');
  }

  return {
    port,
    databaseUrl: environment.DATABASE_URL,
    databaseSsl: databaseSsl === 'require',
    shopJwtSecret,
    shopJwtIssuer: environment.SHOP_JWT_ISSUER || 'print-wallah',
    shopJwtAudience: environment.SHOP_JWT_AUDIENCE || 'print-wallah-shops',
    superAdminJwtSecret,
    superAdminJwtIssuer: environment.SUPER_ADMIN_JWT_ISSUER || 'print-wallah',
    superAdminJwtAudience: environment.SUPER_ADMIN_JWT_AUDIENCE || 'developers-admin',
    paymentWebhookSecret,
    onboardingBaseUrl: onboardingUrl.toString(),
    planDurationsDays: parsePlanDurations(environment.SUBSCRIPTION_PLANS),
  };
}

module.exports = { loadConfiguration, parsePlanDurations };