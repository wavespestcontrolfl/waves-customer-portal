/**
 * Public moving page routes — /api/public/moving/:token.
 *
 * The link the office sends a customer who is moving (owner 2026-11-02, dark
 * behind GATE_MOVING_FLOW). No auth: the 48-hex token on customer_moves is the
 * only gate, the same model as the price-change and re-service pages.
 *
 * Minimal PII (same contract as routes/price-change-public.js): first name,
 * the plan's service names, the move status and dates, and only the CITY of a
 * submitted new address. Never the current street address, a phone number, an
 * email address or money. Every response is `Cache-Control: private, no-store`.
 *
 * GET  /:token         the page's data (services/customer-moves publicMoveView)
 * POST /:token/check   check a typed address (paid Google call: 10 per link per
 *                      Eastern day, the same text reused for 24 hours)
 * POST /:token/submit  save the move; answers the fixed receipt sentences
 *
 * Gate off, a malformed token, an unknown token and a closed move all answer
 * the same 404. This route sends no message and changes no visit, price or
 * property.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const logger = require('../services/logger');
const { movingFlowLive } = require('../config/feature-gates');
const Moves = require('../services/customer-moves');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');

const PRIVACY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

const NOT_FOUND = { error: 'Not found' };

// Dark = unobservable: no headers a probe could tell apart from any other 404.
router.use((req, res, next) => {
  res.set(PRIVACY_HEADERS);
  if (!movingFlowLive()) return res.status(404).json(NOT_FOUND);
  return next();
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

// The paid address check gets a tighter per-IP limit on top of the per-link
// daily cap in the service.
const checkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many checks. Please try again in a minute.' },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

async function loadMove(req, res) {
  const token = String(req.params.token || '');
  if (!Moves.TOKEN_RE.test(token)) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  const move = await Moves.loadMoveByToken(token);
  if (!move) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  return move;
}

function sendFailure(res, err, label) {
  if (err instanceof Moves.MoveError) return res.status(err.status).json({ error: err.message });
  logger.error(`[moving-public] ${label} failed: ${err.message}`);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

router.get('/:token', async (req, res) => {
  try {
    const move = await loadMove(req, res);
    if (!move) return undefined;
    return res.json(await Moves.publicMoveView(move));
  } catch (err) {
    return sendFailure(res, err, 'view');
  }
});

router.post('/:token/check', checkLimiter, async (req, res) => {
  try {
    const move = await loadMove(req, res);
    if (!move) return undefined;
    const address = req.body && typeof req.body.address === 'string' ? req.body.address : '';
    const result = await Moves.checkMoveAddress(move, address);
    // The page confirms the address with the customer, so it gets the typed
    // text, Google's version and the verdict. Never a street address of the
    // CURRENT home.
    return res.json({ typed: result.typed, normalized: result.normalized, verdict: result.verdict });
  } catch (err) {
    return sendFailure(res, err, 'check');
  }
});

router.post('/:token/submit', submitLimiter, async (req, res) => {
  try {
    const move = await loadMove(req, res);
    if (!move) return undefined;
    const body = req.body || {};
    const saved = await Moves.submitMove(move, {
      useCheckedAddress: body.useCheckedAddress === true,
      moveOutDate: body.moveOutDate,
      moveInDate: body.moveInDate,
    });
    return res.json({ ok: true, receipt: Moves.receiptFor(saved.view), view: saved.view });
  } catch (err) {
    return sendFailure(res, err, 'submit');
  }
});

module.exports = router;
