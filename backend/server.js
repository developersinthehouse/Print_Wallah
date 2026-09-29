const path = require('node:path');
const express = require('express');
const { createSuperAdminAuth, createSuperAdminRouter } = require('./adminRoutes');
const { createSuperAdminSessionRouter } = require('./adminSessionRoutes');
const { loadConfiguration } = require('./config');
const { createPool } = require('./db/pool');
const { runMigrations } = require('./db/migrate');
const { createShopAuth } = require('./middleware/shopAuth');
const { createSubscriptionCheck } = require('./middleware/subCheck');
const { createPostgresRepositories } = require('./postgresRepositories');
const { createShopRouter } = require('./shopRoutes');
const { createShopSessionRouter } = require('./shopSessionRoutes');
const { createSubscriptionRouter } = require('./subscriptionRoutes');
const { startExpiryMonitor } = require('./subscriptionEngine');

function createApp({ pool, configuration, logger = console }) {
  const repositories = createPostgresRepositories(pool);
  const authenticateShop = createShopAuth({
    jwtSecret: configuration.shopJwtSecret,
    issuer: configuration.shopJwtIssuer,
    audience: configuration.shopJwtAudience,
  });
  const requireActiveSubscription = createSubscriptionCheck({
    shopRepository: repositories.shopRepository,
  });
  const authenticateSuperAdmin = createSuperAdminAuth({
    jwtSecret: configuration.superAdminJwtSecret,
    issuer: configuration.superAdminJwtIssuer,
    audience: configuration.superAdminJwtAudience,
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', async (request, response) => {
    try {
      await pool.query('SELECT 1');
      return response.json({ status: 'ok', database: 'connected' });
    } catch {
      return response.status(503).json({ status: 'unavailable', database: 'disconnected' });
    }
  });

  app.use('/api/subscriptions', createSubscriptionRouter({
    shopRepository: repositories.shopRepository,
    paymentWebhookSecret: configuration.paymentWebhookSecret,
    planDurationsDays: configuration.planDurationsDays,
  }));
  app.use('/api/admin-auth', createSuperAdminSessionRouter({
    pool,
    jwtSecret: configuration.superAdminJwtSecret,
    issuer: configuration.superAdminJwtIssuer,
    audience: configuration.superAdminJwtAudience,
  }));
  app.use('/api/shop-auth', createShopSessionRouter({
    pool,
    jwtSecret: configuration.shopJwtSecret,
    issuer: configuration.shopJwtIssuer,
    audience: configuration.shopJwtAudience,
  }));
  app.use('/api/shops', createShopRouter({
    shopRepository: repositories.shopRepository,
    printJobRepository: repositories.printJobRepository,
    authenticateShop,
    requireActiveSubscription,
  }));
  app.use('/api/admin', createSuperAdminRouter({
    shopRepository: repositories.shopRepository,
    printJobRepository: repositories.printJobRepository,
    adminRepository: repositories.adminRepository,
    authenticateSuperAdmin,
    onboardingBaseUrl: configuration.onboardingBaseUrl,
    planDurationsDays: configuration.planDurationsDays,
  }));

  const viewsDirectory = path.join(__dirname, '..', 'frontend', 'views');
  const assetDirectory = path.join(__dirname, '..');
  app.get('/assets/pw_logo.jpeg', (request, response) => response.sendFile(path.join(assetDirectory, 'pw_logo.jpeg')));
  app.get('/assets/developers-logo_nobg.webp', (request, response) => response.sendFile(path.join(assetDirectory, 'developers-logo_nobg.webp')));
  app.get('/shop-admin', (request, response) => response.sendFile(path.join(viewsDirectory, 'shop-admin.html')));
  app.get('/super-admin', (request, response) => response.sendFile(path.join(viewsDirectory, 'super-admin.html')));
  app.use((request, response) => response.status(404).json({ error: 'NOT_FOUND' }));
  app.use((error, request, response, next) => {
    const statusCode = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
    if (statusCode === 500) logger.error('Unhandled request error', error);
    return response.status(statusCode).json({
      error: statusCode === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR',
    });
  });

  return app;
}

async function startServer(options = {}) {
  const configuration = options.configuration || loadConfiguration();
  const pool = options.pool || createPool({
    connectionString: configuration.databaseUrl,
    ssl: configuration.databaseSsl,
  });

  try {
    await runMigrations(pool);
    const app = createApp({ pool, configuration, logger: options.logger });
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(configuration.port, () => resolve(listener));
      listener.once('error', reject);
    });
    const stopExpiryMonitor = startExpiryMonitor({
      shopRepository: createPostgresRepositories(pool).shopRepository,
      logger: options.logger || console,
    });

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopExpiryMonitor();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await pool.end();
    };

    return { app, server, pool, shutdown };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function main() {
  const runningServer = await startServer();
  console.info(`Print Wallah API listening on port ${runningServer.server.address().port}`);
  const handleSignal = () => {
    runningServer.shutdown().catch((error) => {
      console.error('Server shutdown failed', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Server startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };