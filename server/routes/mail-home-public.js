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
const logger = require('../services/logger');
const { ipFallbackKey } = require('../middleware/rate-limit-key');

function privacyHeaders(res) {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

const notFound = (res) => res.status(404).json({ error: 'Not found' });
// The raw path, before Express decodes it: one lowercase 32-hex token, with or without a trailing slash. A bad percent
// escape, another path or another case never reaches the route (it would throw in Express's decode and answer 500).
const TOKEN_PATH = /^\/[0-9a-f]{32}\/?$/;

/**
 * Mounted in server/index.js BEFORE the global /api limiter and the body parsers: the privacy headers on every
 * outcome (a global 429 included), and while the gate is off, or for any path or method that is not a page read, the
 * same 404 an unknown token gets. So a dark probe never sees a 429 and the gate is not an oracle.
 */
function preLimiterGuard(req, res, next) {
  privacyHeaders(res);
  if (!mailHomePageLive()) return notFound(res);
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !TOKEN_PATH.test(req.path)) return notFound(res);
  return next();
}

// Per-route read limit on top of the global /api limiter, the same bar as the card route.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // The shared IP key (an IPv6 address counts by its /64, as in public-map-image.js), not the raw address.
  keyGenerator: (req) => ipFallbackKey(req.ip),
  handler: (req, res) => {
    privacyHeaders(res);
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  },
}));

// The error code only: a Knex error message carries the SQL and its bound values, and the bound value here is the
// page token, a credential. The app error handler logs err.message, so the error never goes to next().
const codeOf = (err) => (err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown');

router.get('/:token', async (req, res) => {
  privacyHeaders(res);
  // The guard runs at the mount; the route checks again, so the router is safe mounted alone.
  if (!mailHomePageLive()) return notFound(res);
  try {
    // Only a GET is an open (Express serves HEAD through this handler). shouldRecord skips link-preview and scanner
    // user agents (isBotUserAgent), staff browsers and staff IPs.
    const recordView = req.method === 'GET' && shouldRecord(req);
    const page = await getHomePage(req.params.token, { recordView });
    if (!page) return notFound(res);
    return res.json(page);
  } catch (err) {
    logger.error(`[mail-home-public] page read failed (code=${codeOf(err)})`);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
module.exports.preLimiterGuard = preLimiterGuard;
