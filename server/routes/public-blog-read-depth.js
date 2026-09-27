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
 * What bounds a forged beacon: anyone can send this beacon and claim any
 * fleet Origin. An anonymous, cookie-free browser cannot be authenticated
 * without the identifier E2 rules out (owner scope: no cookies, no IDs), so
 * the route keeps no per-source state beyond the one-minute per-IP limiter
 * every public route carries (codex P1 r2 withdrew the per-source daily
 * dedupe for exactly that reason). Instead:
 *  - a beacon counts only for a path the claimed site's OWN sitemap lists
 *    (sitemap-index.xml, else sitemap.xml, read with the tested content-registry helper,
 *    cached 6 h per site; a failed refresh keeps the last good list and is
 *    retried after 5 min; no list yet means dropped), so invented slugs never
 *    create rows (codex P1 r2) — today every blog post is hub-only, so spoke
 *    beacons find no blog paths and drop;
 *  - each (day, site, path, milestone) bucket stops at DAILY_BUCKET_CAP.
 * The response is the same 204 either way, so it never says which paths
 * are live.
 *
 * Storage: `blog_read_depth_daily` — one row per (day, site, path,
 * milestone), `count` incremented by an INSERT ... ON CONFLICT DO UPDATE
 * that stops at DAILY_BUCKET_CAP.
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
const { fetchSitemapPaths } = require('../services/content/content-registry-live-status');
const { normalizeContentUrl } = require('../services/content/content-registry');

const BODY_LIMIT = '1kb';
// A page view sends at most 5 beacons (25/50/75/100/next); 120/min per IP
// leaves generous headroom for a shared office NAT while bounding a flood.
const RATE_MAX_PER_MIN = Math.max(1, parseInt(process.env.BLOG_READ_DEPTH_RATE_MAX, 10) || 120);

// The six live blog categories — blog URLs are /{category}/{slug}/.
const PATH_RE = /^\/(lawn-care|mosquito|pest-control|seasonal|termite|tree-shrub)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const MAX_PATH_CHARS = 200;
const MILESTONES = new Set(['25', '50', '75', '100', 'next']);
// A real post reaching this many of one milestone on one site in a day would
// be ~15x today's whole daily blog traffic; past it the bucket stops, so a
// forged flood can skew a post by at most this much a day. A saturated
// bucket reads as exactly the cap.
const DAILY_BUCKET_CAP = 2000;

const LIVE_PATHS_TTL_MS = 6 * 60 * 60 * 1000;
// @astrojs/sitemap writes /sitemap-index.xml on every fleet site (live
// 2026-09-27: 200 on the hub and the spokes). /sitemap.xml exists only on
// the hub, as a redirect to that index (spokes 404), so it is the fallback,
// not the default (codex P1 r3 on #5022).
const SITEMAP_PATHS = ['/sitemap-index.xml', '/sitemap.xml'];
const LIVE_PATHS_RETRY_MS = 5 * 60 * 1000;
// site -> { paths: Set|null, ok: bool, checkedAt: ms, pending: Promise|null, outage: bool }
let livePathCache = new Map();

async function fetchSiteSitemap(site) {
  for (const path of SITEMAP_PATHS) {
    const paths = await fetchSitemapPaths({ sitemapUrl: `https://${site}${path}` }).catch(() => null);
    if (paths) return paths;
  }
  return null;
}

// A site whose sitemap can't be read loses (or freezes) its counts without
// any other sign, so each outage is warn-logged once and its recovery once —
// the fleet site key only, never anything from a beacon.
function noteSitemapHealth(site, entry, loaded) {
  if (!loaded && !entry.outage) {
    entry.outage = true;
    logger.warn(`[blog-read-depth] sitemap for ${site} could not be read; ${entry.paths ? 'counting against the last good list' : 'its beacons are dropped'} until it loads (retried every 5 min)`);
  } else if (loaded && entry.outage) {
    entry.outage = false;
    logger.info(`[blog-read-depth] sitemap for ${site} is readable again`);
  }
}

// The claimed site's own sitemap, as normalized content URLs (a bare path
// for the hub, an absolute URL for a spoke — normalizeContentUrl decides
// both sides). One fetch in flight per site; a failed refresh keeps the
// last good list and retries sooner.
function livePaths(site, now) {
  let entry = livePathCache.get(site);
  if (!entry) {
    entry = { paths: null, ok: false, checkedAt: -Infinity, pending: null, outage: false };
    livePathCache.set(site, entry);
  }
  if (entry.pending) return entry.pending;
  if (now - entry.checkedAt < (entry.ok ? LIVE_PATHS_TTL_MS : LIVE_PATHS_RETRY_MS)) return Promise.resolve(entry.paths);
  entry.pending = fetchSiteSitemap(site)
    .then((paths) => {
      entry.checkedAt = now;
      noteSitemapHealth(site, entry, !!paths);
      entry.ok = !!paths;
      if (paths) entry.paths = paths;
      entry.pending = null;
      return entry.paths;
    });
  return entry.pending;
}

async function isLivePath(site, path, now = Date.now()) {
  const paths = await livePaths(site, now);
  return !!paths && paths.has(normalizeContentUrl(`https://${site}${path}`));
}

function resetLivePaths() {
  livePathCache = new Map();
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
  await db.raw(
    `INSERT INTO blog_read_depth_daily (day, site, path, milestone, count)
     VALUES ((now() AT TIME ZONE 'America/New_York')::date, ?, ?, ?, 1)
     ON CONFLICT (day, site, path, milestone)
     DO UPDATE SET count = blog_read_depth_daily.count + 1, updated_at = now()
     WHERE blog_read_depth_daily.count < ?`,
    [site, path, milestone, DAILY_BUCKET_CAP],
  );
}

async function countIfLive(site, path, milestone) {
  if (!(await isLivePath(site, path))) return;
  await writeCount(site, path, milestone);
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

  // Same 204 whether the beacon is counted or dropped, answered before any
  // sitemap read or write: the response never says which paths are live.
  res.status(204).end();
  const site = resolveSite(req);
  if (!site) return undefined;
  void countIfLive(site, value.p, value.m).catch((err) => {
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
module.exports._private = { validateBody, resolveSite, errorKind, isLivePath, resetLivePaths, PATH_RE, MILESTONES, MAX_PATH_CHARS, DAILY_BUCKET_CAP };
