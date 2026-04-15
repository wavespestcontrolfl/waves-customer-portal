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
    const customer = await db('customers')
      .where({ phone, active: true })
      .first();

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

    const customer = await db('customers')
      .where({ phone, active: true })
      .first();

    if (!customer) {
      return res.status(401).json(invalidResponse);
    }

    const token = generateToken(customer.id);
    const refreshToken = generateRefreshToken(customer.id);

    logger.info(`[auth] customer login success: id=${customer.id}`);

    res.json({
      token,
      refreshToken,
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        email: customer.email,
        phone: customer.phone,
        tier: customer.waveguard_tier,
      },
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

    const customer = await db('customers').where({ id: decoded.customerId, active: true }).first();
    if (!customer) return res.status(401).json({ error: 'Invalid refresh token' });

    // Rotate: issue a new access AND refresh token tied to the same customer.
    const newToken = generateToken(customer.id);
    const newRefreshToken = generateRefreshToken(customer.id);
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

module.exports = router;
