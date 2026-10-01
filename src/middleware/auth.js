const jwt = require('jsonwebtoken');

function issue(res, claims) {
  const secret = process.env.JWT_SECRET;
  const value = jwt.sign(claims, secret, { expiresIn: '12h', issuer: 'print-wallah' });
  res.cookie('session', value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 12 * 60 * 60 * 1000, path: '/' });
}

function authenticate(req, res, next) {
  const value = req.cookies?.session;
  if (!value) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(value, process.env.JWT_SECRET, { issuer: 'print-wallah' }); next(); }
  catch { res.clearCookie('session', { path: '/' }); res.status(401).json({ error: 'Session expired. Please sign in again.' }); }
}

function role(...roles) {
  return (req, res, next) => req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have access to this action' });
}

module.exports = { issue, authenticate, role };
