const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');

/**
 * Verify JWT token and attach customer to request
 */
async function authenticateCore(req, res, next, { allowInactive = false } = {}) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret);

    const query = db('customers')
      .where({ id: decoded.customerId })
      .whereNull('deleted_at');
    if (!allowInactive) query.where({ active: true });
    const customer = await query.first();

    if (!customer) {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }

    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) {
      return res.status(401).json({ error: 'Invalid token account' });
    }

    req.customer = customer;
    req.customerId = customer.id;
    // Anything other than active === true counts as inactive (the column is
    // nullable; the strict middleware requires active=true, so a NULL-active
    // customer must not slip past allow-inactive routes' per-action gates).
    req.customerInactive = customer.active !== true;
    req.accountId = decoded.accountId || customerAccountId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authenticate(req, res, next) {
  return authenticateCore(req, res, next, { allowInactive: false });
}

/**
 * Same as authenticate but admits an INACTIVE (not deleted) customer, setting
 * req.customerInactive so the route can gate per-action. Exists for the
 * cancellation-request path: auto-processing churns the account (active=false)
 * mid-flight, and a client retry after a lost response must still reach the
 * idempotent dedupe/repair sweep instead of dying on a 401 here. Routes using
 * this MUST explicitly reject inactive customers for anything else.
 */
function authenticateAllowInactive(req, res, next) {
  return authenticateCore(req, res, next, { allowInactive: true });
}

/**
 * Generate JWT for a customer
 */
function generateToken(customerId, accountId = null) {
  return jwt.sign(
    { customerId, accountId: accountId || undefined },
    config.jwt.secret,
    { expiresIn: config.jwt.expiry }
  );
}

function generateRefreshToken(customerId, accountId = null) {
  return jwt.sign(
    { customerId, accountId: accountId || undefined, type: 'refresh' },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiry }
  );
}

module.exports = { authenticate, authenticateAllowInactive, generateToken, generateRefreshToken };
