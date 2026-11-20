/**
 * Anonymous, cookie-free form step counter — POST /api/public/form-steps.
 *
 * Owner *build* 2026-11-19 (quiz funnel scope: step counts with no cookie on
 * the two quiz pages and the main quote form, all 17 sites). A near copy of
 * the blog read-depth beacon (routes/public-blog-read-depth.js). The
 * marketing sites' quote form and the hub's two quiz pages fire one
 * `fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit',
 * mode: 'no-cors' })` per funnel step. The response is opaque to the browser
 * (mode: 'no-cors'), so it matters only for tests and abuse posture.
 *
 * Body: a JSON string sent as `text/plain;charset=UTF-8` — a CORS "simple"
 * request, so the browser never preflights it. `{"f":"quote","s":"email"}`.
 * `f` is the form and `s` the step; only the pairs in FORM_STEPS count.
 *
 * No feature gate: this counts anonymous aggregate steps and cannot message
 * a customer, change a price, charge, delete data, spend money or add a
 * token page (the read-depth route's GATE_BLOG_READ_DEPTH is not copied).
 *
 * Mount position (server/index.js): the whole router is mounted ABOVE the
 * global `cors({ origin: allowedOrigins })`, the global `app.use('/api/',
 * limiter)` and the global body parsers, right next to the read-depth mount,
 * so a visitor's beacons never spend the budget quote-form or booking calls
 * need. The router ends in a terminal 404, so no request that reaches it —
 * any method, any subpath — falls through to the app's request logger.
 * Beacons are no-cors `text/plain` POSTs whose response the page never
 * reads, so the route sets no CORS headers. It does set
 * `Cross-Origin-Resource-Policy: cross-origin` on every answer: the app's
 * helmet runs above this router and marks every response `same-origin`, and
 * a browser turns a no-cors response with that header into a network error
 * (the step counts, but the page's fetch rejects and the console logs a
 * blocked request for every step). The 204 and the 429 have no body, and the
 * 404 is the generic one, so there is nothing to keep same-origin.
 *
 * Answers: every POST gets the same 204 — a valid step, an unknown form or
 * step, a bad or oversized body, an unknown Origin — sent BEFORE any write,
 * so the response never says what counted. The only other answer is the
 * per-IP limiter's 429.
 *
 * What bounds a forged beacon: anyone can send this beacon and claim any
 * fleet Origin, and an anonymous, cookie-free browser cannot be
 * authenticated, so the route keeps no per-source state beyond the
 * one-minute per-IP limiter. A fixed allowlist keeps invented forms and
 * steps out of the table, and each (day, site, form, step) bucket stops at
 * DAILY_BUCKET_CAP.
 *
 * Storage: `form_step_daily` — one row per (day, site, form, step), `count`
 * incremented by an INSERT ... ON CONFLICT DO UPDATE that stops at
 * DAILY_BUCKET_CAP. `day` is the America/New_York calendar day, computed in
 * SQL — never from request data. The table has NO timestamp column: a
 * bucket records how many, never when (a bucket holding one `lead` would
 * otherwise say when that lead happened). `site` is derived ONLY from the
 * Origin header (never the body): the header must be ONE serialized https
 * origin with no port, and its hostname must be a fleet site in
 * server/services/content-astro/spoke-sites.js — a missing, null, malformed
 * or unknown origin drops the beacon. Nothing else about the request — IP,
 * user agent, referrer, cookies, raw body — is ever stored or logged.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { notFoundBody } = require('../middleware/errors');
const { noStore } = require('../middleware/no-store');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { normalizeSpokeSites } = require('../services/content-astro/spoke-sites');

const BODY_LIMIT = '1kb';
// A form visit sends at most about 12 beacons (a quiz up to 16); 120/min per
// IP leaves generous headroom for a shared office NAT while bounding a flood.
const RATE_MAX_PER_MIN = Math.max(1, parseInt(process.env.FORM_STEPS_RATE_MAX, 10) || 120);

const QUIZ_STEPS = Object.freeze([
  'view', 'start', 'seeing', 'property', 'timeline', 'name', 'email', 'phone',
  'address', 'lead', 'end_call', 'end_business', 'end_price', 'end_review',
  'call_tap', 'price_tap',
]);
// form -> the steps it may report. A step from another form's list is dropped.
const FORM_STEPS = Object.freeze({
  quote: Object.freeze([
    'view', 'start', 'interest', 'frequency', 'family', 'product', 'cadence',
    'name', 'email', 'phone', 'address', 'lead',
  ]),
  pest_quiz: QUIZ_STEPS,
  lawn_quiz: QUIZ_STEPS,
});
// A real step reaching this many on one site in a day would be far past
// today's whole daily form traffic; past it the bucket stops, so a forged
// flood can skew a step by at most this much a day. A saturated bucket
// reads as exactly the cap. Same value as the read-depth counter.
const DAILY_BUCKET_CAP = 2000;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Pure — returns { error } or { value: { f, s } } — so tests can pin every
// branch. Own-property lookup only: `constructor`, `__proto__` and the rest
// of Object.prototype are never a form.
function validateBody(raw) {
  let payload;
  try {
    payload = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    return { error: 'invalid_json' };
  }
  if (!isPlainObject(payload)) return { error: 'invalid_json' };
  const f = typeof payload.f === 'string' ? payload.f : '';
  if (!f || !Object.prototype.hasOwnProperty.call(FORM_STEPS, f)) return { error: 'invalid_form' };
  const s = typeof payload.s === 'string' ? payload.s : '';
  if (!FORM_STEPS[f].includes(s)) return { error: 'invalid_step' };
  return { value: { f, s } };
}

// Site key derived ONLY from the Origin header. A browser sends one
// serialized origin (scheme://host), so anything else is not a fleet page's
// beacon: a bare domain, a path or query, a port, http, a comma-joined pair
// or a JSON list. The registry's normalizer accepts those shapes because it
// also reads configuration values, so the header is reduced to its hostname
// HERE and only that string reaches the registry (www-stripped, checked
// against the real fleet set — SPOKE_SITES includes the Hub entry, so a
// hub-origin beacon resolves too). Never throws: this runs after the 204, and
// a throw would reach the app's error logger with the request attached.
function resolveSite(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.origin !== origin) return null;
  const [site] = normalizeSpokeSites(url.hostname);
  return site || null;
}

// Only a fixed error KIND ever reaches the log: a pg SQLSTATE / Node errno
// code, else the error's class name, else 'error'. Never err.message — knex
// prefixes it with the SQL and its bound values (site/form/step), e.g.
// on a code-less "Connection terminated unexpectedly".
function errorKind(err) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const name = err && err.name;
  if (typeof name === 'string' && /^[A-Za-z]{0,60}Error$/.test(name)) return name;
  return 'error';
}

async function writeCount(site, form, step) {
  await db.raw(
    `INSERT INTO form_step_daily (day, site, form, step, count)
     VALUES ((now() AT TIME ZONE 'America/New_York')::date, ?, ?, ?, 1)
     ON CONFLICT (day, site, form, step)
     DO UPDATE SET count = form_step_daily.count + 1
     WHERE form_step_daily.count < ?`,
    [site, form, step, DAILY_BUCKET_CAP],
  );
}

const router = express.Router();

// Privacy headers FIRST, so every answer from this router (the 204, the 429
// and the terminal 404) carries no-store/noindex/no-referrer.
router.use(noStore);

// Every answer may be received cross-origin (see the header comment): helmet
// set `same-origin` above this router, and this replaces it.
router.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// Per-IP limiter ahead of the body parser, so a flood is refused before any
// body is buffered, and so beacons cannot exhaust the global limiter's
// budget (this router is mounted above it).
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: RATE_MAX_PER_MIN,
  keyGenerator: unauthenticatedAuthLimitKey,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).end(),
}));

// The body is a JSON string sent as text/plain (a CORS "simple" request);
// `type: () => true` buffers it as text regardless of what Content-Type (if
// any) actually rides along. 1 KB is generous for `{"f":"...","s":"..."}`.
// The parser runs for POST / ONLY: every other method and subpath goes
// straight to the terminal 404 below with its body unread.
const readBody = express.text({ type: () => true, limit: BODY_LIMIT });
// An oversized or unparseable body is dropped with the same 204 as every
// other dropped beacon — never echoed back, never counted.
function parseBeaconBody(req, res, next) {
  readBody(req, res, (err) => {
    if (err) {
      res.status(204).end();
      return;
    }
    next();
  });
}

router.post('/', parseBeaconBody, (req, res) => {
  const { error, value } = validateBody(req.body);
  // Same 204 whether the beacon is counted or dropped, answered before any
  // write: the response never says what counted.
  res.status(204).end();
  if (error) return undefined;
  const site = resolveSite(req);
  if (!site) return undefined;
  void writeCount(site, value.f, value.s).catch((err) => {
    // Never log the site/form/step here beyond the fixed error kind — this
    // is the ONE catch on the fire-and-forget write and must not leak any
    // request data (AGENTS.md non-card PII rule covers shape too).
    logger.warn(`[form-steps] write failed: ${errorKind(err)}`);
  });
  return undefined;
});

// Terminal: any other method or subpath ends here with the generic 404,
// so nothing that reached this privacy router falls through to the app's
// request logger (remote IP, referrer, user agent) further down.
router.use((req, res) => res.status(404).json(notFoundBody(req)));

module.exports = router;
module.exports._private = { validateBody, resolveSite, errorKind, FORM_STEPS, DAILY_BUCKET_CAP };
module.exports.FORM_STEPS = FORM_STEPS;
