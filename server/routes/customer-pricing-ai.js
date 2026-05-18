const express = require('express');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const { buildCustomerPricingResponse } = require('../services/customer-pricing-ai');

const router = express.Router();

const pricingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customer?.id || req.ip,
  message: { error: 'Too many pricing requests. Please wait before asking WAVES AI again.' },
});

const querySchema = Joi.object({
  prompt: Joi.string().trim().allow('').max(240).default(''),
});

router.use(authenticate);

router.post('/query', pricingLimiter, async (req, res, next) => {
  try {
    const { value, error } = querySchema.validate(req.body || {}, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await buildCustomerPricingResponse({
      customer: req.customer,
      prompt: value.prompt,
      db,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
