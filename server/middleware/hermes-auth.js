/**
 * Hermes worker auth — machine-to-machine, NOT admin bearer.
 *
 * The Hermes (Docker) acquisition agent authenticates with a shared service
 * token (HERMES_SERVICE_TOKEN), sent as `Authorization: Bearer <token>` or
 * `X-Hermes-Token`. Fails closed: 403 if the gate is off, 503 if no token is
 * configured, 401 on mismatch (constant-time compare).
 */
const crypto = require('crypto');
const { isEnabled } = require('../config/feature-gates');

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hermesAuth(req, res, next) {
  if (!isEnabled('hermesWorker')) {
    return res.status(403).json({ error: 'hermes worker integration disabled' });
  }
  const expected = process.env.HERMES_SERVICE_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'hermes worker not configured' });
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.headers['x-hermes-token'] || '');
  if (!safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'invalid worker token' });
  }
  next();
}

module.exports = { hermesAuth, safeEqual };
