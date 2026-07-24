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

// Privacy headers on EVERY outcome — including 404s, errors, AND the rate
// limiter's own 429s, which is why this mounts BEFORE the limiter (Codex
// #2771 r6): the token is a bearer credential on a payment-adjacent
// surface, so responses must never be cached, the token must never leak
// via Referer from any rendered content, and the URLs must never be
// indexed.
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  next();
});

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
    if (data.state === 'ready' || data.state === 'prepay_selected') {
      // The public page has no other authenticated key source — same
      // bootstrap shape as the estimate card-capture endpoints.
      // prepay_selected also carries a live SetupIntent (the "save a card
      // instead" fallback), so it needs the key too.
      data.publishableKey = require('../config/stripe-config').publishableKey;
    }
    return res.json(data);
  } catch (err) {
    logger.error(`[secure-card-public] page load failed: ${err.message}`);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

// Plan selection (GATE_SECURE_PLAN_CHOICE lane). The client sends ONLY the
// plan name — every amount is re-derived server-side. 404 while the gate is
// off (unobservable while dark) and for unknown tokens; state conflicts map
// to 409s the page renders as its existing closed/secured states.
router.post('/:token/select-plan', async (req, res) => {
  const token = String(req.params.token || '');
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });
  try {
    const { selectSecurePlan } = require('../services/secure-appointment-plans');
    const result = await selectSecurePlan({
      token,
      plan: typeof req.body?.plan === 'string' ? req.body.plan : null,
    });
    return res.json(result);
  } catch (err) {
    const code = err.code || null;
    if (code === 'gate_off' || code === 'not_found') return res.status(404).json({ error: 'Not found' });
    if (code === 'invalid_plan') return res.status(400).json({ error: 'Unknown plan.' });
    if (code === 'already_secured') return res.status(409).json({ error: 'This appointment is already secured.', code });
    if (code === 'no_longer_needed') return res.status(409).json({ error: 'This appointment no longer needs a card on file.', code });
    if (code === 'prepay_overlap' || code === 'plan_unavailable' || code === 'selection_conflict') {
      // Not sellable right now (existing term, price changed, concurrent
      // update) — the page refetches and renders whatever state is true.
      return res.status(409).json({ error: 'That option is no longer available. Refresh to see current options.', code: 'plan_unavailable' });
    }
    logger.error(`[secure-card-public] select-plan failed: ${err.message}`);
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
      if (result.code === 'no_longer_needed') {
        // Visit cancelled/past or now payer-billed since page load — the
        // client maps this to its "nothing needed" state.
        return res.status(409).json({ error: 'This appointment no longer needs a card on file.', code: 'no_longer_needed' });
      }
      if (result.code === 'completion_in_progress') {
        // The webhook (or another tab) holds the completion claim and is
        // actively saving this card — not a failure. The client shows the
        // secured state; the durable webhook path finishes the save.
        return res.status(409).json({ error: 'Your card is being saved.', code: 'completion_in_progress' });
      }
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
