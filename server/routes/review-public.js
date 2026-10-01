const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ReviewService = require('../services/review-request');
const { noStore } = require('../middleware/no-store');
const { rateLimitKey } = require('../middleware/rate-limit-key');

// Public review flow keyed only by the review_requests.token in the URL.
// Baseline public-token-route guards (docs/public-route-contracts.md):
// privacy headers on every response, a router-wide limiter, and a token
// format gate that runs BEFORE any DB read so a malformed probe is
// indistinguishable from an unknown or expired token.
router.use(noStore);
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests. Please try again later.' },
}));

const NOT_FOUND = { error: 'Review link not found or expired' };

router.param('token', (req, res, next, token) => {
  if (ReviewService.REVIEW_TOKEN_RE.test(String(token))) return next();
  return res.status(404).json(NOT_FOUND);
});

// GET /api/review/:token — public review page data (no auth)
router.get('/:token', async (req, res, next) => {
  try {
    const data = await ReviewService.getByToken(req.params.token);
    if (!data) return res.status(404).json(NOT_FOUND);
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/review/:token — RETIRED (owner ruling 2026-09-29: the 1-10 rating is
// gone). It was an unauthenticated rating write that stamped redirected_at /
// status 'reviewed' without any Google tap, fired the referral invite, and
// finalized the row so a later real /go tap bounced. 410 with no DB access
// (the token-format gate still runs first).
router.post('/:token', (req, res) => res.status(410).json({ error: 'This review flow has been retired' }));

module.exports = router;
