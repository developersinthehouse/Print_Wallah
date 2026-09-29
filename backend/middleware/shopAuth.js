const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ALLOWED_SHOP_ROLES = new Set(['SHOP_ADMIN', 'PRINT_AGENT']);

function createShopAuth({ jwtSecret, issuer, audience, agentTokenRepository }) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new TypeError('Shop JWT secret must contain at least 32 bytes');
  }
  if (!issuer || !audience) {
    throw new TypeError('Shop JWT issuer and audience are required');
  }

  return async function authenticateShop(request, response, next) {
    const authorization = request.get('authorization') || '';
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!tokenMatch) {
      return response.status(401).json({ error: 'SHOP_AUTH_REQUIRED' });
    }

    const token = tokenMatch[1];
    if (token.startsWith('pwa_')) {
      if (!agentTokenRepository || typeof agentTokenRepository.findActiveByHash !== 'function') {
        return response.status(401).json({ error: 'INVALID_SHOP_TOKEN' });
      }
      let agentToken;
      try {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        agentToken = await agentTokenRepository.findActiveByHash(tokenHash);
      } catch (error) {
        return next(error);
      }
      if (!agentToken) return response.status(401).json({ error: 'INVALID_SHOP_TOKEN' });
      request.auth = { shopId: agentToken.shop_id, role: 'PRINT_AGENT', agentTokenId: agentToken.id };
      return next();
    }

    try {
      const claims = jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        issuer,
        audience,
      });
      if (!ALLOWED_SHOP_ROLES.has(claims.role)) {
        return response.status(403).json({ error: 'SHOP_ROLE_REQUIRED' });
      }
      if (typeof claims.shopId !== 'string' || !claims.shopId) {
        return response.status(401).json({ error: 'INVALID_SHOP_TOKEN' });
      }
      request.auth = { shopId: claims.shopId, role: claims.role };
      return next();
    } catch {
      return response.status(401).json({ error: 'INVALID_SHOP_TOKEN' });
    }
  };
}

module.exports = { createShopAuth };
