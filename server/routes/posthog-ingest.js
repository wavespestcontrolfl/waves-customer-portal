/**
 * First-party PostHog ingest proxy — /ingest/* → PostHog Cloud (US).
 *
 * Why: ad blockers drop 10–25% of events posted straight to *.posthog.com
 * (PostHog's own figure). Same-site ingestion on portal.wavespestcontrol.com
 * is on no block list, so the hub (PUBLIC_POSTHOG_HOST) and the portal SPA
 * (VITE_POSTHOG_HOST) can point their SDK here and the funnels stay whole.
 *
 * Contract: a transparent pass-through for whatever posthog-js sends — /e/,
 * /i/v0/e/, /batch/, /flags/, /decide/, /s/ (replay) on the API host, and
 * /static/* (array.js, the recorder) plus /array/<key>/config (remote config)
 * on PostHog's assets host — the same split as PostHog's own proxy docs.
 * Upstream hosts are FIXED here, never derived from the request, so nothing can
 * steer this anywhere else. Consent gating, PII scrubbing and replay masking are
 * the SDKs' job and are unchanged: this route only sees what the browser already
 * sends to PostHog today.
 *
 * Abuse posture:
 *  - GATE_POSTHOG_INGEST_PROXY off → 404, the dark-surface contract every other
 *    gated public route uses. Read at REQUEST time (gateEnvValue: 1/true/on),
 *    so unsetting it on Railway kills the route in the running process.
 *    Revoke = unset the gate AND revert the SDK host env on the caller (a
 *    live SDK pointed at a 404 host just drops events).
 *  - GET / POST / OPTIONS only; 2 MB body cap; 10 s upstream timeout; a
 *    per-IP limiter (POSTHOG_INGEST_RATE_MAX/min, default 300; IPv6 collapsed
 *    to /64 via the shared unauthenticated key) sits AFTER the gate so
 *    gate-off probes stay an unobservable 404 and never spend budget.
 *  - Request headers are ALLOWLISTED (content-type, accept, accept-language,
 *    origin, user-agent, the preflight pair): cookies, authorization,
 *    referer, content-encoding and every proxy-chain / client-IP header of
 *    any spelling never reach PostHog.
 *  - X-Forwarded-For carries the visitor IP (req.ip, trust-proxy aware) so
 *    PostHog's GeoIP keeps working — otherwise every event geolocates to
 *    Railway.
 *  - Mounted BEFORE helmet, the CORS allowlist, and the body parsers: PostHog's
 *    own CORS headers pass through verbatim (it reflects any origin), so spoke
 *    domains work without widening the portal allowlist, and helmet's
 *    same-origin CORP never blocks the hub from loading array.js from here.
 *  - Nothing from the request is ever logged — not the body, not the path (a
 *    caller can put anything in `/ingest/<segment>`); upstream failures log
 *    the method, a fixed route category and the error kind only.
 */
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { gateEnvValue } = require('../config/feature-gates');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const logger = require('../services/logger');

const API_HOST = 'https://us.i.posthog.com';
const ASSET_HOST = 'https://us-assets.i.posthog.com';
const BODY_LIMIT = '2mb';
const UPSTREAM_TIMEOUT_MS = 10000;
// Upstream responses are STREAMED to the client with backpressure, never
// materialised: a size cap (PostHog's biggest asset, array.full.js, is a
// couple of MB) and a downstream write deadline bound what a slow or
// abandoned reader can keep alive. The in-flight slot is held until the
// downstream write has finished or the connection has closed.
const MAX_RESPONSE_BYTES = Math.max(1024, parseInt(process.env.POSTHOG_INGEST_MAX_RESPONSE_BYTES, 10) || 8 * 1024 * 1024);
const RESPONSE_WRITE_TIMEOUT_MS = Math.max(100, parseInt(process.env.POSTHOG_INGEST_RESPONSE_TIMEOUT_MS, 10) || 15000);
const METHODS = new Set(['GET', 'POST', 'OPTIONS']);
// posthog-js sends roughly 10–20 requests/min per active visitor (events,
// replay batches every few seconds, flags); 300/min per IP leaves room for a
// shared office NAT while bounding a flood of 2 MB × 10 s upstream holds.
const RATE_MAX_PER_MIN = Math.max(1, parseInt(process.env.POSTHOG_INGEST_RATE_MAX, 10) || 300);
// Process-wide in-flight cap, checked BEFORE the body is buffered: the
// per-IP limiter bounds requests per minute, not concurrent bytes — 300
// simultaneous 2 MB bodies held for a 10 s upstream call would be ~600 MB.
// 32 × 2 MB caps that at 64 MB; the (n+1)th concurrent request is a fast 503
// and posthog-js simply retries later. Analytics is best-effort; the portal
// serving customers is not.
const MAX_IN_FLIGHT = Math.max(1, parseInt(process.env.POSTHOG_INGEST_MAX_IN_FLIGHT, 10) || 32);
// Per-IP share of those slots (same /64-collapsed key as the limiter): a
// browser tab keeps 1–2 ingest requests open at once, so 4 is generous for a
// real visitor and stops one caller from parking on every slot with partial
// uploads (32 slots × 15 s deadline needs only 128 req/min — under the
// per-minute budget).
const MAX_IN_FLIGHT_PER_IP = Math.max(1, parseInt(process.env.POSTHOG_INGEST_MAX_IN_FLIGHT_PER_IP, 10) || 4);
const inFlightByKey = new Map();
// A slot is reserved BEFORE the body is read, so a stalled upload must not
// keep it: the whole request body has this long to arrive (posthog-js bodies
// are at most a replay batch — well under a second on any real link).
const UPLOAD_TIMEOUT_MS = Math.max(100, parseInt(process.env.POSTHOG_INGEST_UPLOAD_TIMEOUT_MS, 10) || 15000);
let inFlight = 0;

// Request headers forwarded upstream — an ALLOWLIST, so nothing a caller
// invents (proxy-chain headers of any spelling, client-IP variants, auth,
// cookies, referer, content-encoding) can reach PostHog. posthog-js sends
// only content-type / origin on its own; accept, accept-language and
// user-agent are harmless and keep the assets host serving the right thing;
// the access-control-request-* pair is the preflight. The only attribution
// PostHog sees is the X-Forwarded-For set from req.ip below. (content-
// encoding is deliberately absent: express.raw() has already inflated the
// body, so posthog-js's own payload compression, which rides in
// `?compression=gzip-js`, is unaffected and the bytes forwarded are plain.)
const FORWARD_REQUEST_HEADERS = new Set([
  'content-type', 'accept', 'accept-language', 'origin', 'user-agent',
  'access-control-request-method', 'access-control-request-headers',
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
  // Same split as PostHog's own Cloudflare proxy: static assets AND the
  // /array/<key>/config remote-config files live on the assets host.
  const base = (tail.startsWith('/static/') || tail.startsWith('/array/')) ? ASSET_HOST : API_HOST;
  const url = new URL(tail, base);
  if (url.origin !== base) throw new Error('upstream origin escaped');
  return url.toString();
}

function upstreamHeaders(req) {
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!FORWARD_REQUEST_HEADERS.has(name)) continue;
    if (typeof value === 'string') out[name] = value;
  }
  if (req.ip) out['x-forwarded-for'] = req.ip;
  return out;
}

// The in-flight slot is taken before the body is buffered and handed back
// only once the upstream work has SETTLED — never on the client's 'close',
// or an upload-and-disconnect loop could hold more than MAX_IN_FLIGHT
// fetches open. A disconnect instead aborts the upstream call, which settles
// it (and frees the slot) at once.
function releaseSlot(res) {
  if (res.locals.ingestSlot) {
    res.locals.ingestSlot = false;
    inFlight -= 1;
    const key = res.locals.ingestKey;
    const n = (inFlightByKey.get(key) || 1) - 1;
    if (n <= 0) inFlightByKey.delete(key); else inFlightByKey.set(key, n);
  }
  if (res.locals.ingestUploadTimer) {
    clearTimeout(res.locals.ingestUploadTimer);
    res.locals.ingestUploadTimer = null;
  }
}

// Passes bytes through untouched but fails the pipeline once the cap is
// crossed, which tears down both ends (upstream stream cancelled, client
// socket destroyed) instead of holding a growing buffer.
function byteCap(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        const err = new Error('ingest response too large');
        err.code = 'ERR_INGEST_RESPONSE_TOO_LARGE';
        return cb(err);
      }
      return cb(null, chunk);
    },
  });
}

async function proxy(req, res) {
  // Body fully buffered — the upload deadline no longer applies.
  if (res.locals.ingestUploadTimer) {
    clearTimeout(res.locals.ingestUploadTimer);
    res.locals.ingestUploadTimer = null;
  }
  let url;
  try {
    url = upstreamUrl(req);
  } catch {
    releaseSlot(res);
    return res.status(400).end();
  }
  const category = url.startsWith(ASSET_HOST) ? 'static' : 'ingest';
  const controller = new AbortController();
  // Phase 1 deadline: upstream must answer (headers) within UPSTREAM_TIMEOUT_MS.
  let timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let clientGone = false;
  const onClientGone = () => {
    if (!res.writableFinished) {
      clientGone = true;
      controller.abort();
    }
  };
  res.once('close', onClientGone);
  let sizeExceeded = false;
  try {
    const hasBody = req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0;
    const upstream = await fetch(url, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Phase 2 deadline: the whole downstream write must finish within
    // RESPONSE_WRITE_TIMEOUT_MS — a reader that stops consuming is cut off,
    // upstream cancelled with it.
    timer = setTimeout(() => {
      controller.abort();
      res.destroy(new Error('ingest downstream write timeout'));
    }, RESPONSE_WRITE_TIMEOUT_MS);
    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
    });
    // The hub loads /ingest/static/array.js cross-origin (www → portal);
    // helmet's default CORP would refuse it, so say so explicitly here.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!upstream.body) {
      res.end();
      return;
    }
    const cap = byteCap(MAX_RESPONSE_BYTES);
    cap.once('error', (e) => { if (e && e.code === 'ERR_INGEST_RESPONSE_TOO_LARGE') sizeExceeded = true; });
    // pipeline() resolves only when `res` has finished, and rejects when
    // either end goes away — so the slot (released in finally) outlives the
    // downstream write, and a premature client close cancels upstream.
    await pipeline(Readable.fromWeb(upstream.body), cap, res);
  } catch (e) {
    if (sizeExceeded) {
      controller.abort();
      logger.warn(`[posthog-ingest] upstream response over ${MAX_RESPONSE_BYTES} bytes (${category}) — cut off`);
      if (!res.headersSent) res.status(502).end(); else res.destroy();
    } else if (!clientGone) {
      // Never echo the request: the path is caller-controlled free text.
      const kind = e && e.name === 'AbortError' ? 'timeout' : (e && e.code) || (e && e.name) || 'error';
      logger.warn(`[posthog-ingest] upstream failed ${req.method} ${category}: ${kind}`);
      if (!res.headersSent) res.status(502).end(); else res.destroy();
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClientGone);
    releaseSlot(res);
  }
}

const router = express.Router();

router.use((req, res, next) => {
  // Call-time read (not the load-time gates snapshot): a Railway unset is a
  // live kill, as documented.
  if (!gateEnvValue('GATE_POSTHOG_INGEST_PROXY')) return res.status(404).end();
  if (!METHODS.has(req.method)) return res.status(405).set('Allow', 'GET, POST, OPTIONS').end();
  return next();
});

// Per-IP limiter AFTER the gate: a disabled route stays a plain 404 that
// consumes nothing, and an enabled one cannot be used to flood PostHog or
// tie up the portal with concurrent 2 MB / 10 s upstream holds.
// Keyed like every other unauthenticated limiter in the app: raw req.ip would
// hand an IPv6 client a fresh bucket per address inside its /64.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: RATE_MAX_PER_MIN,
  keyGenerator: unauthenticatedAuthLimitKey,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).end(),
}));

// Concurrency bound before any byte is buffered. The slot is released by
// proxy()'s finally (after upstream settles) or by the error handler below
// (a 413 / aborted upload that never reached proxy()).
router.use((req, res, next) => {
  const key = unauthenticatedAuthLimitKey(req) || 'unknown';
  if (inFlight >= MAX_IN_FLIGHT || (inFlightByKey.get(key) || 0) >= MAX_IN_FLIGHT_PER_IP) {
    return res.status(503).set('Retry-After', '5').end();
  }
  inFlight += 1;
  inFlightByKey.set(key, (inFlightByKey.get(key) || 0) + 1);
  res.locals.ingestSlot = true;
  res.locals.ingestKey = key;
  // Upload deadline: a body still incomplete when this fires is torn down,
  // which surfaces in express.raw as an aborted-request error → the error
  // handler below releases the slot. Cleared once the body is in (proxy()).
  res.locals.ingestUploadTimer = setTimeout(() => {
    res.locals.ingestUploadTimer = null;
    if (!req.complete) req.destroy(new Error('ingest upload timeout'));
  }, UPLOAD_TIMEOUT_MS);
  // A connection that closes while the body is still being read never
  // reaches proxy() and may not raise a parser error either — release here.
  // proxy() takes over the slot lifecycle once the body is in (req.complete),
  // so this only acts on the buffering phase.
  res.once('close', () => { if (!req.complete) releaseSlot(res); });
  return next();
});

// Buffer whatever content-type posthog-js uses (text/plain, form-urlencoded,
// JSON, gzip-js binary) — the global parsers never see this router.
router.use(express.raw({ type: () => true, limit: BODY_LIMIT }));

router.all('*', proxy);

// express.raw's oversize error carries status 413; anything else is ours.
 
router.use((err, req, res, next) => {
  releaseSlot(res);
  if (!res.headersSent && !res.destroyed) res.status(err && err.status ? err.status : 502).end();
});

module.exports = router;
module.exports.upstreamUrl = upstreamUrl;
module.exports.API_HOST = API_HOST;
module.exports.ASSET_HOST = ASSET_HOST;
module.exports.inFlightCount = () => inFlight;
module.exports.inFlightCountFor = (key) => inFlightByKey.get(key) || 0;
