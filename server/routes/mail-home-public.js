/**
 * Public page of one new home on the mail list (mailer step 2c, server half), mounted at /api/public/home.
 *
 *   GET /api/public/home/:token   → { address, price, plan } for the client page /h/:token (a later PR)
 *
 * The 32-hex page_token on the mail_prospects row IS the credential, the same trust contract as the other /:token
 * customer surfaces. Behind GATE_MAIL_HOME_PAGE (dark): with the gate off every request gets the same 404 an unknown
 * or malformed token gets, so the gate is not an oracle. Every outcome carries no-store and noindex headers.
 * Contract: docs/public-route-contracts.md.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { mailHomePageLive } = require('../config/feature-gates');
const { shouldRecord } = require('../services/customer-page-views');
const { getHomePage } = require('../services/mail/home-page');

function privacyHeaders(res) {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

// Per-route read limit on top of the global /api limiter, the same bar as the card route.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    privacyHeaders(res);
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  },
}));

router.get('/:token', async (req, res, next) => {
  try {
    privacyHeaders(res);
    if (!mailHomePageLive()) return res.status(404).json({ error: 'Not found' });
    // shouldRecord skips link-preview and scanner user agents (isBotUserAgent), staff browsers and staff IPs.
    const page = await getHomePage(req.params.token, { recordView: shouldRecord(req) });
    if (!page) return res.status(404).json({ error: 'Not found' });
    return res.json(page);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
