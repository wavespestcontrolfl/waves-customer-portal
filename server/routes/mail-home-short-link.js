/**
 * The short typed address of a new home (mailer step 2d-2), mounted at /nh ("new home").
 *
 *   GET /nh/:slug   → 302 /h/<page_token> for a live home of the new-home list; every other outcome → 302 to the
 *                     marketing site (https://www.wavespestcontrol.com/), the same place gowavesfl.com sends any path today
 *
 * The postcard prints "gowavesfl.com/101-example". A Cloudflare rule (NOT part of this build; docs/public-route-contracts.md)
 * sends the paths that look like a slug to portal.wavespestcontrol.com/nh/<slug>; this route does the lookup.
 *
 * A dead slug never errors: the gate off (GATE_MAIL_HOME_PAGE), a bad shape, an unknown slug, a home that is not live
 * (not_eligible, unmatched), a row of another list and a failed lookup all give the same redirect to the marketing site,
 * so a printed card never lands on an error page and the gate is not an oracle. The only other answer is 429 when a
 * client asks more than 60 times a minute. Not an open redirect: both targets are fixed (the site, or a path built from a
 * stored 32-hex token); nothing in the request names them.
 *
 * /go (routes/outbound-redirect.js, the prep-guide outside links) is a separate root and is not touched.
 *
 * The slug is not a credential (owner 2026-11-23: guessing is fine), but the Location it returns IS the home's bearer
 * link, so every answer carries no-store, noindex and no-referrer, and the redirect is never cached.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { mailHomePageLive } = require('../config/feature-gates');
const { SLUG_RE, MAX_SLUG_LENGTH } = require('../services/mail/home-slug');
const { ipFallbackKey } = require('../middleware/rate-limit-key');
const logger = require('../services/logger');

const MARKETING_SITE = 'https://www.wavespestcontrol.com/';
const LIST_KEY = 'new_home'; // services/mail/new-home-list.js LIST_KEY
const LIVE_STATUSES = ['eligible', 'held_back'];
const TOKEN_RE = /^[0-9a-f]{32}$/;
// The raw path, before Express decodes it: one slug (any letter case) with or without a trailing slash. A bad percent
// escape never reaches a decode that could throw.
const SLUG_PATH = /^\/([0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*)\/?$/i;

function privacyHeaders(res) {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
}
const toSite = (res) => res.redirect(302, MARKETING_SITE);

// The privacy headers on every answer; a method other than GET and HEAD finds no handler below (Express answers 404).
router.use((req, res, next) => {
  privacyHeaders(res);
  // Only GET and HEAD exist here; any other method is a 404 whatever the gate (no redirect, no database).
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text').send('Not found');
  // Gate off and bad shapes need no database and no limiter.
  if (!mailHomePageLive()) return toSite(res);
  const match = SLUG_PATH.exec(req.path);
  if (!match || match[1].length > MAX_SLUG_LENGTH || !SLUG_RE.test(match[1].toLowerCase())) return toSite(res);
  req.pageSlug = match[1].toLowerCase();
  return next();
});

// Small limiter: a household scans once or twice. The shared IP key (an IPv6 address counts by its /64).
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipFallbackKey(req.ip),
  handler: (req, res) => {
    privacyHeaders(res);
    res.status(429).type('text').send('Too many requests. Please try again in a minute.');
  },
}));

router.get('/:slug', async (req, res) => {
  try {
    const row = await db('mail_prospects')
      .where({ page_slug: req.pageSlug, list_key: LIST_KEY })
      .whereIn('status', LIVE_STATUSES)
      .first('page_token');
    if (!row || typeof row.page_token !== 'string' || !TOKEN_RE.test(row.page_token)) return toSite(res);
    return res.redirect(302, `/h/${row.page_token}`);
  } catch (err) {
    // The error code only: a Knex message carries the SQL and its bound values.
    const code = err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown';
    logger.error(`[mail-home-short-link] lookup failed (code=${code})`);
    return toSite(res);
  }
});

module.exports = router;
