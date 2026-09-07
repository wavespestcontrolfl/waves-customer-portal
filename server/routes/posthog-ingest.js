/**
 * First-party PostHog ingest proxy — /ingest/* → PostHog Cloud (US).
 *
 * Why: ad blockers drop 10–25% of events posted straight to *.posthog.com
 * (PostHog's own figure). Same-site ingestion on portal.wavespestcontrol.com
 * is on no block list, so the hub (PUBLIC_POSTHOG_HOST) and the portal SPA
 * (VITE_POSTHOG_HOST) can point their SDK here and the funnels stay whole.
 *
 * Contract: a transparent pass-through for whatever posthog-js sends — /e/,
 * /i/v0/e/, /batch/, /flags/, /decide/, /s/ (replay), /array/<key>/config, and
 * /static/* (array.js, the recorder) which lives on PostHog's assets host.
 * Upstream hosts are FIXED here, never derived from the request, so nothing can
 * steer this anywhere else. Consent gating, PII scrubbing and replay masking are
 * the SDKs' job and are unchanged: this route only sees what the browser already
 * sends to PostHog today.
 *
 * Abuse posture:
 *  - GATE_POSTHOG_INGEST_PROXY off → 404, the dark-surface contract every other
 *    gated public route uses. Revoke = unset the gate AND revert the SDK host
 *    env on the caller (a live SDK pointed at a 404 host just drops events).
 *  - GET / POST / OPTIONS only; 2 MB body cap; 10 s upstream timeout.
 *  - Cookies and Authorization never cross in either direction; Referer is
 *    dropped (a tokenized portal URL is not PostHog's business).
 *  - X-Forwarded-For carries the visitor IP (req.ip, trust-proxy aware) so
 *    PostHog's GeoIP keeps working — otherwise every event geolocates to
 *    Railway.
 *  - Mounted BEFORE helmet, the CORS allowlist, and the body parsers: PostHog's
 *    own CORS headers pass through verbatim (it reflects any origin), so spoke
 *    domains work without widening the portal allowlist, and helmet's
 *    same-origin CORP never blocks the hub from loading array.js from here.
 *  - Bodies are never logged; only upstream failures (status + path).
 */
const express = require('express');
const featureGates = require('../config/feature-gates');
const logger = require('../services/logger');

const API_HOST = 'https://us.i.posthog.com';
const ASSET_HOST = 'https://us-assets.i.posthog.com';
const BODY_LIMIT = '2mb';
const UPSTREAM_TIMEOUT_MS = 10000;
const METHODS = new Set(['GET', 'POST', 'OPTIONS']);

// Hop-by-hop headers plus everything that must not cross the boundary.
const DROP_REQUEST_HEADERS = new Set([
  'host', 'cookie', 'authorization', 'referer', 'connection', 'content-length',
  'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'accept-encoding',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'true-client-ip',
]);
// fetch() hands back a DECODED body, so the upstream encoding/length headers
// would lie; set-cookie and HSTS are PostHog's, not ours.
const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'connection', 'content-length', 'content-encoding',
  'transfer-encoding', 'keep-alive', 'upgrade', 'strict-transport-security',
  'alt-svc',
]);

function upstreamUrl(req) {
  // originalUrl keeps the query string; baseUrl is the mount point ('/ingest').
  const raw = String(req.originalUrl || '').slice(String(req.baseUrl || '').length);
  // Pin to the fixed origin: a protocol-relative tail ('//evil.com/e/') or a
  // backslash one ('/\\evil.com') would otherwise resolve OFF the PostHog host
  // (WHATWG URL treats '\\' as '/' for https). Collapse every leading slash /
  // backslash to a single '/', then let URL normalise any ../ inside.
  const tail = '/' + raw.replace(/^[\\/]+/, '');
  const base = tail.startsWith('/static/') ? ASSET_HOST : API_HOST;
  const url = new URL(tail, base);
  if (url.origin !== base) throw new Error('upstream origin escaped');
  return url.toString();
}

function upstreamHeaders(req) {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === 'string') out[name] = value;
  }
  if (req.ip) out['x-forwarded-for'] = req.ip;
  return out;
}

async function proxy(req, res) {
  let url;
  try {
    url = upstreamUrl(req);
  } catch {
    return res.status(400).end();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const hasBody = req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0;
    const upstream = await fetch(url, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
    });
    // The hub loads /ingest/static/array.js cross-origin (www → portal);
    // helmet's default CORP would refuse it, so say so explicitly here.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(body);
  } catch (e) {
    logger.warn(`[posthog-ingest] upstream failed ${req.method} ${req.path}: ${e && e.name === 'AbortError' ? 'timeout' : (e && e.message)}`);
    if (!res.headersSent) res.status(502).end();
  } finally {
    clearTimeout(timer);
  }
}

const router = express.Router();

router.use((req, res, next) => {
  if (!featureGates.isEnabled('posthogIngestProxy')) return res.status(404).end();
  if (!METHODS.has(req.method)) return res.status(405).set('Allow', 'GET, POST, OPTIONS').end();
  return next();
});

// Buffer whatever content-type posthog-js uses (text/plain, form-urlencoded,
// JSON, gzip-js binary) — the global parsers never see this router.
router.use(express.raw({ type: () => true, limit: BODY_LIMIT }));

router.all('*', proxy);

// express.raw's oversize error carries status 413; anything else is ours.
 
router.use((err, req, res, next) => {
  res.status(err && err.status ? err.status : 502).end();
});

module.exports = router;
module.exports.upstreamUrl = upstreamUrl;
module.exports.API_HOST = API_HOST;
module.exports.ASSET_HOST = ASSET_HOST;
