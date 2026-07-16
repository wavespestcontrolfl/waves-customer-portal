/**
 * Public "secure your appointment" endpoints (mounted at
 * /api/public/secure-card) — the card-on-file capture page the
 * appointment-card-request funnel texts a link to.
 *
 *   GET  /api/public/secure-card/:token           → page payload by state
 *   POST /api/public/secure-card/:token/complete  → live-verify + save card
 *
 * Token-scoped public routes, same trust contract as the other /:token
 * customer surfaces (reschedule/estimate/card): the 64-hex token IS the
 * credential; unknown tokens 404 with no existence oracle. No money moves
 * here — a SetupIntent saves the card; charges happen at service
 * completion through the existing per-application path.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const logger = require('../services/logger');
const {
  loadSecureCardPageData,
  completeSecureCardCapture,
} = require('../services/appointment-card-request');

const TOKEN_RE = /^[a-f0-9]{64}$/;

// Per-route limit on top of the global /api limiter — same bar as the
// sibling public token routes (card, prep, lawn-diagnostic).
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

router.get('/:token', async (req, res) => {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = await loadSecureCardPageData(token);
    if (!data) return res.status(404).json({ error: 'Not found' });
    if (data.state === 'ready') {
      // The public page has no other authenticated key source — same
      // bootstrap shape as the estimate card-capture endpoints.
      data.publishableKey = require('../config/stripe-config').publishableKey;
    }
    res.set('Cache-Control', 'private, no-store');
    return res.json(data);
  } catch (err) {
    logger.error(`[secure-card-public] page load failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/:token/complete', async (req, res) => {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await completeSecureCardCapture({
      token,
      setupIntentId: typeof req.body?.setupIntentId === 'string' ? req.body.setupIntentId : null,
      ip: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return res.status(404).json({ error: 'Not found' });
      // intent_mismatch / verification_failed / pm_ownership_mismatch /
      // completion_failed — the customer retries from the page; details
      // stay in the logs, not the response.
      return res.status(409).json({ error: 'That card could not be verified. Please try again.' });
    }
    return res.json({ success: true, alreadyCompleted: !!result.alreadyCompleted });
  } catch (err) {
    logger.error(`[secure-card-public] complete failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
