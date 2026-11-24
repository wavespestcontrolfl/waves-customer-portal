/**
 * Public page of one new home on the mail list (mailer step 2c, server half), mounted at /api/public/home.
 *
 *   GET  /api/public/home/:token         → { address, price, plan } for the client page /h/:token (a later PR)
 *   GET  /api/public/home/:token/times   → { offers } the open first-visit times of the home, soonest first
 *   POST /api/public/home/:token/book    → { offer, name, phone, email }: a REAL booking (estimate + customer + first
 *                                           visit) through the /book funnel's own createSelfBooking, which sends the
 *                                           normal booking confirmation (services/mail/home-book.js)
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
const { getHomeTimes, bookHome } = require('../services/mail/home-book');
const logger = require('../services/logger');
const { ipFallbackKey } = require('../middleware/rate-limit-key');

function privacyHeaders(res) {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

// Every 404 is the same answer: the rate-limit headers the limiters set on a live request (the global one and this
// router's) are dropped, so a gate-off 404 (answered before any limiter) and an unknown-token 404 cannot be told apart.
const RATE_LIMIT_HEADER = /^(x-)?ratelimit/i;
const notFound = (res) => {
  for (const name of res.getHeaderNames()) if (RATE_LIMIT_HEADER.test(name)) res.removeHeader(name);
  return res.status(404).json({ error: 'Not found' });
};
// The raw path, before Express decodes it: one lowercase 32-hex token, with or without a trailing slash. A bad percent
// escape, another path or another case never reaches the route (it would throw in Express's decode and answer 500).
const TOKEN_PATH = /^\/[0-9a-f]{32}\/?$/;
const TIMES_PATH = /^\/[0-9a-f]{32}\/times\/?$/;
const BOOK_PATH = /^\/[0-9a-f]{32}\/book\/?$/;

/**
 * Mounted in server/index.js with the router, BEFORE the CORS handlers, the global /api limiter and the body parsers: the privacy headers on every
 * outcome (a global 429 included), and while the gate is off, or for any path or method that is not a page read, the
 * same 404 an unknown token gets. So a dark probe never sees a 429 and the gate is not an oracle. Allowed: GET/HEAD
 * /:token, GET /:token/times, POST /:token/book. Everything else is that 404.
 */
function preLimiterGuard(req, res, next) {
  privacyHeaders(res);
  if (!mailHomePageLive()) return notFound(res);
  const read = (req.method === 'GET' || req.method === 'HEAD') && TOKEN_PATH.test(req.path);
  const times = req.method === 'GET' && TIMES_PATH.test(req.path);
  const book = req.method === 'POST' && BOOK_PATH.test(req.path);
  if (!read && !times && !book) return notFound(res);
  return next();
}

// The limiters' shared options: the shared IP key (an IPv6 address counts by its /64, as in public-map-image.js), not the
// raw address, and a 429 that keeps the private headers.
const limitOptions = (max) => ({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipFallbackKey(req.ip),
  handler: (req, res) => {
    privacyHeaders(res);
    res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
  },
});
// Per-route read limit on top of the global /api limiter, the same bar as the card route.
router.use(rateLimit(limitOptions(60)));
// A times read runs the /book finder and a geocode; a booking writes a customer, an estimate and a visit and sends the
// confirmation. Both are tighter than the page read (a household books once or twice).
const timesLimiter = rateLimit(limitOptions(15));
const bookLimiter = rateLimit(limitOptions(5));

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

router.get('/:token/times', timesLimiter, async (req, res) => {
  privacyHeaders(res);
  if (!mailHomePageLive()) return notFound(res);
  try {
    const times = await getHomeTimes(req.params.token);
    if (!times) return notFound(res);
    if (times.error) return res.status(503).json({ error: times.error });
    return res.json({ offers: times.offers });
  } catch (err) {
    logger.error(`[mail-home-public] times read failed (code=${codeOf(err)})`);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// The body parser is this route's own (the router is mounted before the app's parsers): 4 KB, JSON only. A body that
// does not parse, or is too large, is the same invalid_contact answer, never the app's error page.
const bookBody = express.json({ limit: '4kb' });
const parseBookBody = (req, res, next) => bookBody(req, res, (err) => {
  if (!err) return next();
  privacyHeaders(res);
  return res.status(400).json({ error: 'invalid_contact' });
});

router.post('/:token/book', bookLimiter, parseBookBody, async (req, res) => {
  privacyHeaders(res);
  if (!mailHomePageLive()) return notFound(res);
  try {
    const result = await bookHome(req.params.token, req.body && typeof req.body === 'object' ? req.body : {});
    if (!result) return notFound(res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    logger.error(`[mail-home-public] booking failed (code=${codeOf(err)})`);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
module.exports.preLimiterGuard = preLimiterGuard;
