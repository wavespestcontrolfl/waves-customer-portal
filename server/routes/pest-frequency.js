/**
 * One-touch pest visit frequency change — customer portal (owner 2026-11-12).
 *
 *   GET  /api/pest-frequency          → { available, current, options } for the My Plan card
 *   POST /api/pest-frequency/preview  → the outcome of one choice: prices, the visit kept, the dates booked
 *   POST /api/pest-frequency/confirm  → the change, for the outcome the customer was shown (`version`)
 *
 * DARK behind GATE_PEST_FREQUENCY_CHANGE, read at request time. Off, the card's read answers
 * { available: false } (the card never renders) and both writes answer 404. Rules, money and the
 * re-booking live in services/pest-frequency-change.js; a refusal there keeps the office path.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { pestFrequencyChangeLive } = require('../config/feature-gates');
const pestFrequency = require('../services/pest-frequency-change');

router.use(authenticate);

// Per customer, low ceilings: a preview runs the re-booking in a transaction it rolls back, and a
// confirm changes a plan's price. Confirm keeps its own allowance (one-tap-purchase.js, codex r11 P2).
const limiter = (max) => rateLimit({
  windowMs: 60 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.customerId || req.ip,
  message: { error: 'Too many attempts. Please wait a moment or call our office.' },
});
const previewLimiter = limiter(30);
const confirmLimiter = limiter(10);

const FREQUENCIES = new Set(['bimonthly', 'monthly']);

function sendServiceError(err, res, next) {
  if (!err.status) return next(err);
  return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}

function chosenFrequency(req, res) {
  const frequency = String(req.body?.frequency || '');
  if (FREQUENCIES.has(frequency)) return frequency;
  res.status(400).json({ error: 'frequency required' });
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    if (!pestFrequencyChangeLive()) return res.json({ available: false });
    return res.json(await pestFrequency.status(req.customerId));
  } catch (err) { return next(err); }
});

router.post('/preview', previewLimiter, async (req, res, next) => {
  try {
    if (!pestFrequencyChangeLive()) return res.status(404).json({ error: 'Not available' });
    const frequency = chosenFrequency(req, res);
    if (!frequency) return undefined;
    return res.json(await pestFrequency.preview(req.customerId, frequency));
  } catch (err) { return sendServiceError(err, res, next); }
});

router.post('/confirm', confirmLimiter, async (req, res, next) => {
  try {
    if (!pestFrequencyChangeLive()) return res.status(404).json({ error: 'Not available' });
    const frequency = chosenFrequency(req, res);
    if (!frequency) return undefined;
    return res.json(await pestFrequency.confirm(req.customerId, frequency, {
      version: req.body?.version, ip: req.ip, userAgent: req.get('user-agent') || null,
    }));
  } catch (err) { return sendServiceError(err, res, next); }
});

module.exports = router;
