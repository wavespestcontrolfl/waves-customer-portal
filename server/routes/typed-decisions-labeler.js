/**
 * Typed-decision labeler token: the one way the Claude labeling runner (two
 * blind graders that agree; owner 2026-10-02) writes a label without a
 * person's admin session. Contract: docs/public-route-contracts.md
 * "Typed-decision labeler token".
 *
 * Mounted in server/index.js at /api/admin/typed-decisions ABOVE the global
 * cors(), the global /api/ limiter and the body parsers, in front of the admin
 * router (routes/admin-typed-decisions.js), whose own
 * `adminAuthenticate, requireAdmin` guard is untouched. A request WITHOUT the
 * X-Labeler-Token header falls straight through to the rest of the app. A
 * request WITH it never leaves this router: privacy headers, then the generic
 * 404 for a wrong / short / unset token (TYPED_DECISIONS_LABELER_TOKEN, 32+
 * characters, constant-time compare, no DB read), any method or path other
 * than POST /reviews/<uuid>/label, or GATE_TYPED_DECISIONS off; then the Staff
 * maintenance interlock (503 while staff writes are frozen), its own
 * /64-keyed limiter, a small JSON parser, and the SAME label write the admin
 * route uses (labelReview), which narrows a machine caller: no force, only
 * rows still unreviewed, labeled_by 'claude-labeler', audit actor 'system'.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { typedDecisionsLive } = require('../config/feature-gates');
const { safeEqual } = require('../middleware/hermes-auth');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { staffMaintenance } = require('../middleware/staff-maintenance');
const { labelReview } = require('./admin-typed-decisions');

const router = express.Router();

const LABEL_PATH = /^\/reviews\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/label$/i;
const MIN_LABELER_TOKEN_CHARS = 32;
const labelerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Token callers carry no JWT: key by the /64-collapsed client IP.
  keyGenerator: unauthenticatedAuthLimitKey,
});

function labelerPreGuard(req, res, next) {
  const supplied = req.get('x-labeler-token');
  // No header: not ours. Leave this router; the admin router (and its admin
  // sign-in) handles the request exactly as before.
  if (supplied === undefined) return next('router');
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  const expected = process.env.TYPED_DECISIONS_LABELER_TOKEN || '';
  const ok = expected.length >= MIN_LABELER_TOKEN_CHARS && safeEqual(supplied, expected);
  if (!ok || req.method !== 'POST' || !LABEL_PATH.test(req.path) || !typedDecisionsLive()) return res.status(404).json({ error: 'Not found' });
  req.machineLabeler = true;
  return next();
}

router.use(labelerPreGuard);
// This router answers ahead of the app-wide Staff maintenance interlock, so a
// verified token passes through the same interlock here: while staff writes are
// frozen for a maintenance migration, so are the labeler's (Codex #5677 r4).
router.post('/reviews/:id/label', staffMaintenance, labelerLimiter, express.json({ limit: '16kb' }), labelReview);
// Terminal: a request with the header never falls through to another router.
router.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// The parser's own failures (a valid caller's malformed or oversized body) are
// answered here: the global error handler would turn them into a 500.
 
router.use((err, req, res, next) => {
  if (!req.machineLabeler) return next(err);
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) return res.status(400).json({ error: 'Invalid JSON body' });
  return next(err);
});

module.exports = router;
module.exports.labelerPreGuard = labelerPreGuard;
