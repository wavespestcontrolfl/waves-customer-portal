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

// POST /api/review/:token — submit rating (no auth)
router.post('/:token', async (req, res, next) => {
  try {
    const { rating, feedbackText } = req.body;
    if (!rating || rating < 1 || rating > 10) {
      return res.status(400).json({ error: 'Rating must be between 1 and 10' });
    }
    const result = await ReviewService.submitRating(req.params.token, { rating, feedbackText });
    res.json(result);
  } catch (err) {
    if (err.message === 'Already rated') return res.status(409).json({ error: err.message });
    // Unknown and expired tokens get the same body as a malformed one — a
    // distinct 410 would confirm that a token once existed.
    if (err.message === 'Review request not found' || err.message === 'Review link expired') {
      return res.status(404).json(NOT_FOUND);
    }
    next(err);
  }
});

module.exports = router;
