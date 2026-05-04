const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');

/**
 * Verify JWT token and attach customer to request
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret);

    const customer = await db('customers')
      .where({ id: decoded.customerId, active: true })
      .first();

    if (!customer) {
      return res.status(401).json({ error: 'Customer not found or inactive' });
    }

    const customerAccountId = customer.account_id || customer.id;
    if (decoded.accountId && String(decoded.accountId) !== String(customerAccountId)) {
      return res.status(401).json({ error: 'Invalid token account' });
    }

    req.customer = customer;
    req.customerId = customer.id;
    req.accountId = decoded.accountId || customerAccountId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
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

module.exports = { authenticate, generateToken, generateRefreshToken };
