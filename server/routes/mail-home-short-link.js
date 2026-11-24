/**
 * The short typed address of a new home (mailer step 2d-2), mounted at /nh ("new home").
 *
 *   GET /nh/:slug   → 302 /h/<page_token> for a live home of the new-home list; every other outcome → 302 to the
 *                     marketing site (https://www.wavespestcontrol.com/), the same place gowavesfl.com sends any path today
 *
 * The postcard prints "gowavesfl.com/101-example". A Cloudflare rule (NOT part of this build; docs/public-route-contracts.md)
 * sends the paths that look like a slug to portal.wavespestcontrol.com/nh/<slug>; this route does the lookup.
 *
 * A known slug also adds one to the home's page_typed_views (not awaited: the redirect never waits for it; no IP and no
 * user agent is stored; link-preview and scanner agents, staff browsers and staff IPs are not counted, as for the page's own
 * page_views). Every dead answer carries utm_source=new_home_postcard&utm_medium=print&utm_campaign=typed_link_miss on the
 * marketing site address, so a mistyped card shows in analytics; the gate-off and bad-shape answers carry it too, so the
 * gate is still not an oracle.
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
const { shouldRecord } = require('../services/customer-page-views');
const logger = require('../services/logger');

const MARKETING_SITE = 'https://www.wavespestcontrol.com/?utm_source=new_home_postcard&utm_medium=print&utm_campaign=typed_link_miss';
// A typed-view write that waits longer (a row lock) is canceled, so it never holds a pool connection for long.
const VIEW_WRITE_TIMEOUT_MS = 2000;
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

const codeOf = (err) => (err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown');

// One atomic add, fire and forget. It never throws and logs only the error code (a Knex message carries SQL and bound values).
async function countTypedView(id) {
  try {
    await db('mail_prospects').where({ id }).update({ page_typed_views: db.raw('page_typed_views + 1') })
      .timeout(VIEW_WRITE_TIMEOUT_MS, { cancel: true });
  } catch (err) {
    try { logger.warn(`[mail-home-short-link] typed view write failed (code=${codeOf(err)})`); } catch { /* never throw */ }
  }
}

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
  // No RateLimit headers: gate off answers before the limiter, so their presence would tell the gate's state.
  standardHeaders: false,
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
      .first('id', 'page_token');
    if (!row || typeof row.page_token !== 'string' || !TOKEN_RE.test(row.page_token)) return toSite(res);
    // Only a GET is a use of the printed address (HEAD is served here too); not awaited.
    if (req.method === 'GET' && shouldRecord(req)) void countTypedView(row.id);
    return res.redirect(302, `/h/${row.page_token}`);
  } catch (err) {
    // The error code only: a Knex message carries the SQL and its bound values.
    logger.error(`[mail-home-short-link] lookup failed (code=${codeOf(err)})`);
    return toSite(res);
  }
});

module.exports = router;
