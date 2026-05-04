const express = require('express');
const router = express.Router();
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { generateToken, generateRefreshToken, authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

// =========================================================================
// Rate limiters — protect OTP endpoints from brute force / enumeration
// =========================================================================
const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.phone || ''}`,
  message: { error: 'Too many requests. Please try again later.' },
});

const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.phone || ''}`,
  message: { error: 'Too many verification attempts. Please request a new code.' },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many refresh attempts.' },
});

// Uniform response used to prevent customer enumeration via /send-code
const UNIFORM_SEND_RESPONSE = {
  success: true,
  message: 'If an account exists for that number, a verification code has been sent.',
};

function activeCustomerByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  return db('customers')
    .where({ active: true })
    .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${last10}`])
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc')
    .first();
}

function authCustomerPayload(customer) {
  return {
    id: customer.id,
    accountId: customer.account_id,
    profileLabel: customer.profile_label,
    isPrimaryProfile: customer.is_primary_profile,
    firstName: customer.first_name,
    lastName: customer.last_name,
    email: customer.email,
    phone: customer.phone,
    tier: customer.waveguard_tier,
  };
}

function accountIdForCustomer(customer) {
  return customer?.account_id || customer?.id || null;
}

function propertyPayload(customer) {
  return {
    id: customer.id,
    accountId: customer.account_id,
    profileLabel: customer.profile_label,
    isPrimaryProfile: customer.is_primary_profile,
    firstName: customer.first_name,
    lastName: customer.last_name,
    tier: customer.waveguard_tier,
    monthlyRate: customer.monthly_rate != null ? parseFloat(customer.monthly_rate) : null,
    address: {
      line1: customer.address_line1,
      line2: customer.address_line2,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
    },
  };
}

async function accountPropertiesForCustomer(customer) {
  const query = db('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .select(
      'id',
      'account_id',
      'profile_label',
      'is_primary_profile',
      'first_name',
      'last_name',
      'address_line1',
      'address_line2',
      'city',
      'state',
      'zip',
      'waveguard_tier',
      'monthly_rate',
      'created_at'
    )
    .orderBy('is_primary_profile', 'desc')
    .orderBy('profile_label', 'asc')
    .orderBy('created_at', 'asc');

  if (customer.account_id) {
    query.where({ account_id: customer.account_id });
  } else {
    query.where({ id: customer.id });
  }

  const rows = await query;
  return rows.map(propertyPayload);
}

// =========================================================================
// POST /api/auth/send-code — Send OTP to phone number
// =========================================================================
router.post('/send-code', sendCodeLimiter, async (req, res, next) => {
  try {
    const schema = Joi.object({
      phone: Joi.string().pattern(/^\+1\d{10}$/).required()
        .messages({ 'string.pattern.base': 'Phone must be in +1XXXXXXXXXX format' }),
    });

    const { phone } = await schema.validateAsync(req.body);

    // Check customer exists — but DO NOT leak existence in the response.
    const customer = await activeCustomerByPhone(phone);

    if (customer) {
      try {
        await TwilioService.sendVerificationCode(phone);
      } catch (smsErr) {
        logger.error(`[auth] sendVerificationCode failed for customer ${customer.id}: ${smsErr.message}`);
      }
    } else {
      logger.info(`[auth] send-code attempted for unknown phone (ip=${req.ip})`);
    }

    // Always return the same response regardless of customer existence.
    return res.json(UNIFORM_SEND_RESPONSE);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/auth/verify-code — Verify OTP and return JWT
// =========================================================================
router.post('/verify-code', verifyCodeLimiter, async (req, res, next) => {
  try {
    const schema = Joi.object({
      phone: Joi.string().pattern(/^\+1\d{10}$/).required(),
      code: Joi.string().length(6).required(),
    });

    const { phone, code } = await schema.validateAsync(req.body);

    const result = await TwilioService.checkVerificationCode(phone, code);

    // Uniform error for invalid code OR unknown customer to avoid enumeration.
    const invalidResponse = { error: 'Invalid or expired verification code' };

    if (!result.success) {
      return res.status(401).json(invalidResponse);
    }

    const customer = await activeCustomerByPhone(phone);

    if (!customer) {
      return res.status(401).json(invalidResponse);
    }

    const accountId = accountIdForCustomer(customer);
    const token = generateToken(customer.id, accountId);
    const refreshToken = generateRefreshToken(customer.id, accountId);

    logger.info(`[auth] customer login success: id=${customer.id}`);

    res.json({
      token,
      refreshToken,
      customer: authCustomerPayload(customer),
      properties: await accountPropertiesForCustomer(customer),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/auth/refresh — Refresh an expired token (rotates refresh token)
// =========================================================================
router.post('/refresh', refreshLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const jwt = require('jsonwebtoken');
    const config = require('../config');

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, config.jwt.secret);
    } catch {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    if (decoded.type !== 'refresh' || !decoded.customerId) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const customer = await db('customers').where({ id: decoded.customerId, active: true }).whereNull('deleted_at').first();
    if (!customer) return res.status(401).json({ error: 'Invalid refresh token' });

    const accountId = decoded.accountId || accountIdForCustomer(customer);

    if (decoded.accountId) {
      const customerAccountId = accountIdForCustomer(customer);
      if (String(decoded.accountId) !== String(customerAccountId)) {
        return res.status(401).json({ error: 'Invalid refresh token' });
      }
    }

    // Rotate: issue a new access AND refresh token tied to the same account
    // and currently selected service property.
    const newToken = generateToken(customer.id, accountId);
    const newRefreshToken = generateRefreshToken(customer.id, accountId);
    res.json({ token: newToken, refreshToken: newRefreshToken });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// =========================================================================
// GET /api/auth/me — Get current authenticated customer
// =========================================================================
router.get('/me', authenticate, async (req, res, next) => {
  try {
  const customer = req.customer;
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);

  res.json({
    id: customer.id,
    accountId: customer.account_id,
    profileLabel: customer.profile_label,
    isPrimaryProfile: customer.is_primary_profile,
    firstName: customer.first_name,
    lastName: customer.last_name,
    email: customer.email,
    phone: customer.phone,
    address: {
      line1: customer.address_line1,
      line2: customer.address_line2,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
    },
    property: {
      lawnType: customer.lawn_type,
      propertySqFt: customer.property_sqft,
      lotSqFt: customer.lot_sqft,
      bedSqFt: customer.bed_sqft,
      palmCount: customer.palm_count,
      canopyType: customer.canopy_type,
    },
    tier: customer.waveguard_tier,
    monthlyRate: parseFloat(customer.monthly_rate),
    memberSince: customer.member_since,
    referralCode: customer.referral_code,
    notificationPrefs: prefs ? {
      serviceReminder24h: prefs.service_reminder_24h,
      techEnRoute: prefs.tech_en_route,
      serviceCompleted: prefs.service_completed,
      billingReminder: prefs.billing_reminder,
      seasonalTips: prefs.seasonal_tips,
      smsEnabled: prefs.sms_enabled,
      emailEnabled: prefs.email_enabled,
    } : null,
  });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/auth/properties — List service properties for this login account
// =========================================================================
router.get('/properties', authenticate, async (req, res, next) => {
  try {
    res.json({ properties: await accountPropertiesForCustomer(req.customer) });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/auth/select-property — Switch portal token to another property
// =========================================================================
router.post('/select-property', authenticate, async (req, res, next) => {
  try {
    const schema = Joi.object({
      customerId: Joi.string().uuid().required(),
    });
    const { customerId } = await schema.validateAsync(req.body);

    const target = await db('customers')
      .where({ id: customerId, active: true })
      .whereNull('deleted_at')
      .first();

    if (!target) return res.status(404).json({ error: 'Property not found' });

    const currentAccountId = req.accountId || accountIdForCustomer(req.customer);
    const targetAccountId = accountIdForCustomer(target);
    if (!currentAccountId || String(currentAccountId) !== String(targetAccountId)) {
      return res.status(403).json({ error: 'Property is not available for this account' });
    }

    const token = generateToken(target.id, currentAccountId);
    const refreshToken = generateRefreshToken(target.id, currentAccountId);

    res.json({
      token,
      refreshToken,
      customer: authCustomerPayload(target),
      properties: await accountPropertiesForCustomer(target),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
