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
 * Mount position (server/index.js): this whole router is mounted ABOVE
 * the global `cors({ origin: allowedOrigins })`, the global `app.use('/api/',
 * limiter)` and the global body parsers. Above cors(), because cors() would
 * otherwise answer an allowed-origin OPTIONS preflight with 204 while the
 * route is dark (codex P0 r1 on #5022); above the limiter and parsers, so a
 * reader's beacons never spend the budget quote-form or booking calls need
 * and a dark probe only ever sees the generic 404. The router ends in a
 * terminal 404, so no request that reaches it — any method, any subpath —
 * falls through to the app's request logger further down (codex P1 r1).
 * Beacons are no-cors `text/plain` POSTs whose response the page never
 * reads, so the route sets no CORS headers.
 *
 * One count per source per day: anyone can send this beacon and claim any
 * fleet Origin — an anonymous, cookie-free browser cannot be authenticated
 * without the identifier E2 rules out, and a same-origin proxy would be just
 * as callable. What bounds a single source instead (codex P1 r1): its
 * network address (the limiter's own IPv6-/64-normalized key) is HMACed
 * with a random salt that exists only in this process's memory and is
 * replaced every America/New_York day, together with the site, path and
 * milestone; a repeat digest the same day is dropped (204, nothing written).
 * The address and the digest are never stored or logged, and once the salt
 * rolls over nothing links a digest to anything.
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
const crypto = require('node:crypto');
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
// Past this many distinct beacons in one day, further ones are dropped
// rather than counted: memory stays bounded and a flood can't re-count by
// cycling entries out. Legitimate traffic is a few hundred a day.
const DEDUPE_MAX_ENTRIES = Math.max(1, parseInt(process.env.BLOG_READ_DEPTH_DEDUPE_MAX, 10) || 200000);

let dedupe = { day: null, salt: null, seen: new Set() };

function etDay(now) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// True the first time today that `sourceKey` sends this (site, path,
// milestone); false for a repeat or once the day's cap is reached. See the
// header comment — nothing here is persisted or logged.
function firstBeaconToday(sourceKey, site, path, milestone, now = new Date()) {
  const day = etDay(now);
  if (dedupe.day !== day) dedupe = { day, salt: crypto.randomBytes(32), seen: new Set() };
  const digest = crypto.createHmac('sha256', dedupe.salt)
    .update(`${sourceKey}\n${site}\n${path}\n${milestone}`)
    .digest('base64url')
    .slice(0, 22);
  if (dedupe.seen.has(digest) || dedupe.seen.size >= DEDUPE_MAX_ENTRIES) return false;
  dedupe.seen.add(digest);
  return true;
}

function resetDedupe() {
  dedupe = { day: null, salt: null, seen: new Set() };
}

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
  if (!firstBeaconToday(unauthenticatedAuthLimitKey(req), site, value.p, value.m)) return res.status(204).end();

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

// Terminal: any other method or subpath ends here with the generic 404,
// so nothing that reached this privacy router falls through to the app's
// request logger (remote IP, referrer, user agent) further down.
router.use((req, res) => res.status(404).json(notFoundBody(req)));

module.exports = router;
module.exports._private = { validateBody, resolveSite, errorKind, firstBeaconToday, resetDedupe, PATH_RE, MILESTONES, MAX_PATH_CHARS };
