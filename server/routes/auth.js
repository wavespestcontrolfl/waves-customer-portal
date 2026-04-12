const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { generateToken, generateRefreshToken, authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

// =========================================================================
// POST /api/auth/send-code — Send OTP to phone number
// =========================================================================
router.post('/send-code', async (req, res, next) => {
  try {
    const schema = Joi.object({
      phone: Joi.string().pattern(/^\+1\d{10}$/).required()
        .messages({ 'string.pattern.base': 'Phone must be in +1XXXXXXXXXX format' }),
    });

    const { phone } = await schema.validateAsync(req.body);

    // Check customer exists
    const customer = await db('customers')
      .where({ phone, active: true })
      .first();

    if (!customer) {
      return res.status(404).json({
        error: 'No account found with this phone number. Contact Waves Pest Control to get set up.',
      });
    }

    await TwilioService.sendVerificationCode(phone);

    res.json({ success: true, message: 'Verification code sent' });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/auth/verify-code — Verify OTP and return JWT
// =========================================================================
router.post('/verify-code', async (req, res, next) => {
  try {
    const schema = Joi.object({
      phone: Joi.string().pattern(/^\+1\d{10}$/).required(),
      code: Joi.string().length(6).required(),
    });

    const { phone, code } = await schema.validateAsync(req.body);

    const result = await TwilioService.checkVerificationCode(phone, code);

    if (!result.success) {
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }

    const customer = await db('customers')
      .where({ phone, active: true })
      .first();

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const token = generateToken(customer.id);
    const refreshToken = generateRefreshToken(customer.id);

    logger.info(`Customer logged in: ${customer.first_name} ${customer.last_name} (${customer.id})`);

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
// POST /api/auth/refresh — Refresh an expired token
// =========================================================================
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const decoded = jwt.verify(refreshToken, config.jwt.secret);

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const customer = await db('customers').where({ id: decoded.customerId, active: true }).first();
    if (!customer) return res.status(401).json({ error: 'Customer not found' });

    const newToken = generateToken(customer.id);
    res.json({ token: newToken });
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
