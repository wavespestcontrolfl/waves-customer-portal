/**
 * Anonymous, cookie-free blog read-depth beacon — POST /api/public/blog-read-depth.
 *
 * Owner-approved 2026-09-27 ("E2: cookie-free read-depth counts"), extending
 * the 2026-07-16 exception that lets Cloudflare's cookie-free counter run
 * before cookie consent. The hub (wavespestcontrol.com) and every spoke blog
 * post fire `fetch(url, { method: 'POST', body, keepalive: true,
 * credentials: 'omit', mode: 'no-cors' })` as the reader crosses 25/50/75/100%
 * of the article or reaches the "keep reading" row. The response is opaque
 * to the browser (mode: 'no-cors'), so it matters only for tests and abuse
 * posture, never for the caller's own behavior.
 *
 * Body: a JSON string sent as `text/plain;charset=UTF-8` — a CORS "simple"
 * request, so the browser never preflights it (no custom headers, a
 * safelisted content-type, POST). `{"p":"/pest-control/<slug>/","m":"50"}`.
 *
 * Gate: GATE_BLOG_READ_DEPTH. Ships DARK — off unless exactly 'true'. While
 * dark, EVERY request to this path gets the generic unknown-route 404
 * (middleware/errors.js notFoundBody), before the limiter below, so a dark
 * probe never sees a revealing 429 (the house rule for dark GATE_* routes;
 * AGENTS.md "Public route surface").
 *
 * Mount position (server/index.js): this whole router — gate, limiter,
 * parser — is required and mounted ABOVE the global `app.use('/api/',
 * limiter)` and above the global body parsers, so a reader's scroll beacons
 * never spend the budget a customer's quote-form or booking calls need, and
 * so the dark 404 above is checked before ANY shared middleware could
 * answer instead (a global-limiter 429 while dark would reveal the route).
 * It is mounted BELOW the global `cors({ origin: allowedOrigins })`
 * (server/index.js, ~line 261): allowedOrigins is DERIVED from
 * SPOKE_SITE_KEYS (server/config/cors-origins.js), which already includes
 * the hub and every spoke — so a beacon's Origin is already on the
 * credentialed allowlist and cors() sets normal Access-Control-Allow-Origin
 * headers for it. It also does not need to sit ABOVE cors() the way
 * `/api/public/pest-forecast` does (that route needs a bare `*` for
 * third-party embed domains that are NEVER on the allowlist) — this body is
 * a CORS "simple" request (text/plain, POST, no custom headers), so the
 * browser never sends an OPTIONS preflight for cors() to answer or block in
 * the first place; the mode: 'no-cors' fetch also makes the response
 * opaque to the page regardless of what headers ride back. Net effect:
 * cors() neither blocks nor needs to be bypassed here — the position above
 * the limiter/parsers is the only requirement that matters.
 *
 * Storage: `blog_read_depth_daily` — one row per (day, site, path,
 * milestone), `count` incremented by an INSERT ... ON CONFLICT DO UPDATE.
 * `day` is the America/New_York calendar day, computed in SQL — never from
 * request data. `site` is derived ONLY from the Origin header (never the
 * body) via server/services/content-astro/spoke-sites.js's own
 * normalizeSpokeSites — a missing/null/unknown origin drops the beacon
 * (204, nothing written). Nothing else about the request — IP, user agent,
 * referrer, cookies, raw body — is ever stored or logged.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { notFoundBody } = require('../middleware/errors');
const { noStore } = require('../middleware/no-store');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { normalizeSpokeSites } = require('../services/content-astro/spoke-sites');

const BODY_LIMIT = '1kb';
// A page view sends at most 5 beacons (25/50/75/100/next); 120/min per IP
// leaves generous headroom for a shared office NAT while bounding a flood.
const RATE_MAX_PER_MIN = Math.max(1, parseInt(process.env.BLOG_READ_DEPTH_RATE_MAX, 10) || 120);

// The six live blog categories — blog URLs are /{category}/{slug}/.
const PATH_RE = /^\/(lawn-care|mosquito|pest-control|seasonal|termite|tree-shrub)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const MAX_PATH_CHARS = 200;
const MILESTONES = new Set(['25', '50', '75', '100', 'next']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Pure — returns { error } or { value: { p, m } } — so tests can pin every branch.
function validateBody(raw) {
  let payload;
  try {
    payload = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    return { error: 'invalid_json' };
  }
  if (!isPlainObject(payload)) return { error: 'invalid_json' };
  const p = typeof payload.p === 'string' ? payload.p : '';
  if (!p || p.length > MAX_PATH_CHARS || !PATH_RE.test(p)) return { error: 'invalid_path' };
  const m = typeof payload.m === 'string' ? payload.m : '';
  if (!MILESTONES.has(m)) return { error: 'invalid_milestone' };
  return { value: { p, m } };
}

// Site key derived ONLY from the Origin header, via the spoke registry's own
// normalizer (hostname, www-stripped, checked against the real fleet set —
// SPOKE_SITES includes the Hub entry, so a hub-origin beacon resolves too).
// Null for a missing/null/unknown origin.
function resolveSite(req) {
  const [site] = normalizeSpokeSites(req.headers.origin);
  return site || null;
}

// Only a fixed error KIND ever reaches the log: a pg SQLSTATE / Node errno
// code, else the error's class name, else 'error'. Never err.message — knex
// prefixes it with the SQL and its bound values (site/path/milestone), e.g.
// on a code-less "Connection terminated unexpectedly".
function errorKind(err) {
  const code = err && err.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const name = err && err.name;
  if (typeof name === 'string' && /^[A-Za-z]{0,60}Error$/.test(name)) return name;
  return 'error';
}

async function writeCount(site, path, milestone) {
  await db('blog_read_depth_daily')
    .insert({
      day: db.raw("(now() AT TIME ZONE 'America/New_York')::date"),
      site,
      path,
      milestone,
      count: 1,
    })
    .onConflict(['day', 'site', 'path', 'milestone'])
    .merge({ count: db.raw('blog_read_depth_daily.count + 1'), updated_at: db.raw('now()') });
}

const router = express.Router();

// Privacy headers FIRST — same order as the other dark-gated public routes
// (routes/ops-digest-ingest.js, the /api/public/inspection mount) — so the
// dark 404 below carries no-store/noindex/no-referrer too, not just the
// live outcomes.
router.use(noStore);

// Dark-route check next, ahead of the limiter and the body parser: while
// the gate is off the path must be a plain, generic 404 at any request
// volume — a 429 or a distinguishable body would tell a prober the route
// is real. Read via isEnabled('blogReadDepth'), same convention as the
// other simple dark gates (payerStatements, lawnAssessmentMagnet).
router.use((req, res, next) => {
  if (!isEnabled('blogReadDepth')) return res.status(404).json(notFoundBody(req));
  return next();
});

// Per-IP limiter AFTER the gate: a disabled route stays a plain 404 that
// consumes nothing, and an enabled one cannot be flooded past its own
// budget on top of the global limiter this router is mounted above.
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
// any) actually rides along. 1 KB is generous for `{"p":"...","m":"..."}`.
router.use(express.text({ type: () => true, limit: BODY_LIMIT }));
// express.text's oversize error carries status 413; anything else parsing
// the body itself is treated as a plain 400 — never echoed back.
router.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).end();
  if (err) return res.status(400).end();
  return next();
});

router.post('/', (req, res) => {
  const { error, value } = validateBody(req.body);
  if (error) return res.status(400).end();

  const site = resolveSite(req);
  if (!site) return res.status(204).end();

  // Respond immediately — the write is never on the request's critical path.
  res.status(204).end();
  void writeCount(site, value.p, value.m).catch((err) => {
    // Never log the path/milestone/site here beyond the fixed error kind —
    // this is the ONE catch on the fire-and-forget write and must not leak
    // any request data (AGENTS.md non-card PII rule covers shape too).
    logger.warn(`[blog-read-depth] write failed: ${errorKind(err)}`);
  });
  return undefined;
});

module.exports = router;
module.exports._private = { validateBody, resolveSite, errorKind, PATH_RE, MILESTONES, MAX_PATH_CHARS };
