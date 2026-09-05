/**
 * Link-worker auth — per-provider HMAC request signing for the
 * /api/integrations/*-worker machine-to-machine routes, with a bounded
 * bearer transition for the external Hermes workers.
 *
 * Plan of record: docs/design/backlink-manager-plan.md §12 (signing contract),
 * §3.4c (request audit), §1/§14 (ordered rollout). Summary:
 *
 *  - A signed request carries x-waves-key-id / x-waves-timestamp /
 *    x-waves-nonce / x-waves-signature. The signature is HMAC-SHA256 over the
 *    CANONICAL REQUEST `timestamp \n nonce \n method \n canonical-target \n
 *    body-sha256`, keyed by LINK_WORKER_SECRET_<KEY> (from KEY_RECORDS).
 *    canonical-target = pathname + '?' + every query parameter sorted by key
 *    and percent-encoded (a claim's authority is selected by its query, so a
 *    captured GET can never be replayed with a different mode/type).
 *    body-sha256 is computed over the RAW request bytes captured by the
 *    global express.json verify hook (rawBodyVerify below); for a bodyless
 *    request it is the SHA-256 of the empty byte sequence, on both sides.
 *  - Timestamps outside ±SKEW_MS are rejected. Nonces are consumed
 *    ATOMICALLY, insert-first, into seo_link_worker_nonces (a unique
 *    violation rejects the request before any handler runs). Rows are swept
 *    only once their SIGNED timestamp can no longer validate.
 *  - The `hermes` identity ALSO accepts the legacy HERMES_SERVICE_TOKEN
 *    bearer (Authorization: Bearer / X-Hermes-Token) with identical
 *    capability limits, because the external Hostinger skills cannot be
 *    updated atomically with a server deploy. Bearer removal is the dated
 *    §14 step-1b follow-up, evidenced by this module's audit rows.
 *  - EVERY accepted authentication inserts a seo_link_worker_requests row
 *    (result='authenticated') BEFORE the handler runs — empty claims leave
 *    evidence too — and the handler finalizes it via finalizeWorkerRequest.
 *
 * No new env is required for existing traffic: with no LINK_WORKER_SECRET_*
 * set, bearer-authenticated workers keep working exactly as before (dark).
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');
const { safeEqual } = require('./hermes-auth');

const SKEW_MS = 5 * 60 * 1000;
// Retention ≥ 2× skew from first receipt: a future-dated request stays
// signature-valid for nearly 2× skew, so the sweep deletes only rows whose
// signed timestamp can no longer validate (signed_ts + skew < now - skew).
const NONCE_RETENTION_MS = 3 * SKEW_MS;
const SWEEP_PROBABILITY = 0.04;

// Fixed key registry: key id → provider record. Capabilities are derived ONLY
// after signature verification; a caller-supplied provider field is ignored.
// The vendor credential exists so the price/login workers can migrate off the
// shared bearer BEFORE HERMES_SERVICE_TOKEN is retired (§14 step 1b).
const KEY_RECORDS = {
  hermes_commitments: { provider: 'hermes', secretEnv: 'LINK_WORKER_SECRET_HERMES_COMMITMENTS', endpoints: ['commitments_read'] },
  hermes: { provider: 'hermes', secretEnv: 'LINK_WORKER_SECRET_HERMES', endpoints: ['claim', 'report'] },
  hermes_vendor: { provider: 'hermes', secretEnv: 'LINK_WORKER_SECRET_HERMES_VENDOR', endpoints: ['vendor_price', 'vendor_login'] },
  // The external agent watchdog (docs/hermes/waves-agent-watchdog-skill.md):
  // its own secret and a read-only capability, one identity per lane. HMAC
  // only — the bearer transition below is deliberately NOT extended to it.
  hermes_watchdog: { provider: 'hermes', secretEnv: 'LINK_WORKER_SECRET_HERMES_WATCHDOG', endpoints: ['watchdog'] },
};

// Transitional bearer identity (§1 ordered rollout): same provider record and
// capability limits as the HMAC `hermes` key, logged as auth_scheme='bearer'.
// It is accepted on every legacy hermesAuth mount until each has its own key.
const BEARER_KEY_ID = 'hermes-bearer';
const BEARER_ENDPOINTS = ['claim', 'report', 'vendor_price', 'vendor_login'];

const WORKER_PATH_RE = /^\/api\/integrations\/[^/]*-worker(\/|$)/;

/**
 * verify hook for the global express.json parser: capture the raw request
 * bytes for worker routes only, so the HMAC check hashes the original bytes
 * and never a re-serialized req.body (same pattern as the webhook routes).
 */
function rawBodyVerify(req, res, buf) {
  if (buf && buf.length && WORKER_PATH_RE.test(req.originalUrl.split('?')[0])) {
    req.rawBody = Buffer.from(buf);
  }
}

/**
 * pathname + '?' + every query param sorted by key (then value),
 * percent-encoded with FULL RFC 3986 escaping. encodeURIComponent leaves
 * !'()* bare while the Python signer's quote(safe='') escapes them — without
 * this alignment a validly signed request containing those characters fails.
 */
const rfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalTarget(originalUrl) {
  const u = new URL(originalUrl, 'http://localhost');
  const pairs = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const q = pairs.map((p) => `${p[0]}=${p[1]}`).join('&');
  return q ? `${u.pathname}?${q}` : u.pathname;
}

function bodySha256(req) {
  const raw = req.rawBody && req.rawBody.length ? req.rawBody : Buffer.alloc(0);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function signCanonical(secret, { timestamp, nonce, method, target, bodyHash }) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${method}\n${target}\n${bodyHash}`)
    .digest('hex');
}

function isUniqueViolation(err) {
  return err && (err.code === '23505' || /duplicate key/i.test(err.message || ''));
}

async function sweepNonces() {
  try {
    await db('seo_link_worker_nonces')
      .where('signed_ts', '<', new Date(Date.now() - NONCE_RETENTION_MS))
      .del();
  } catch (err) {
    logger.error('link-worker-auth nonce sweep failed', { error: err.message });
  }
}

async function verifyHmac(req, endpoint) {
  const keyId = String(req.headers['x-waves-key-id'] || '');
  const record = KEY_RECORDS[keyId];
  if (!record) return { status: 401, error: 'unknown worker key' };
  const secret = process.env[record.secretEnv];
  if (!secret) return { status: 503, error: 'worker key not configured' };
  if (!record.endpoints.includes(endpoint)) return { status: 403, error: 'endpoint not permitted for this key' };

  const timestamp = String(req.headers['x-waves-timestamp'] || '');
  const nonce = String(req.headers['x-waves-nonce'] || '');
  const signature = String(req.headers['x-waves-signature'] || '');
  if (!timestamp || !nonce || !signature) return { status: 401, error: 'missing signature headers' };
  if (nonce.length > 128) return { status: 401, error: 'invalid nonce' };

  const signedMs = Date.parse(timestamp);
  if (!Number.isFinite(signedMs)) return { status: 401, error: 'invalid timestamp' };
  if (Math.abs(Date.now() - signedMs) > SKEW_MS) return { status: 401, error: 'timestamp outside window' };

  // A body-bearing request must have its raw bytes captured; without them the
  // hash cannot be proven over the original bytes, so the request is rejected.
  // Body presence is indicated by content-length > 0 OR any transfer-encoding
  // (a chunked request carries no content-length) — a chunked or non-JSON body
  // the express.json verify hook never captured must not authenticate, or a
  // later parser (express.urlencoded) would hand the handler bytes the
  // signature never covered.
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || Boolean(req.headers['transfer-encoding']);
  if (hasBody && !(req.rawBody && req.rawBody.length)) {
    return { status: 401, error: 'raw request body unavailable for signing' };
  }

  const expected = signCanonical(secret, {
    timestamp,
    nonce,
    method: req.method.toUpperCase(),
    target: canonicalTarget(req.originalUrl),
    bodyHash: bodySha256(req),
  });
  if (!safeEqual(signature, expected)) return { status: 401, error: 'invalid signature' };

  // Insert-first nonce consumption: two concurrent copies of one signed
  // request race on the primary key and exactly one proceeds.
  try {
    await db('seo_link_worker_nonces').insert({ key_id: keyId, nonce, signed_ts: new Date(signedMs) });
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 401, error: 'replayed nonce' };
    throw err;
  }
  if (Math.random() < SWEEP_PROBABILITY) await sweepNonces();

  return { keyId, provider: record.provider, authScheme: 'hmac', nonce };
}

function verifyBearer(req) {
  const expected = process.env.HERMES_SERVICE_TOKEN;
  if (!expected) return { status: 503, error: 'hermes worker not configured' };
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-hermes-token'] || '');
  if (!safeEqual(provided, expected)) return { status: 401, error: 'invalid worker token' };
  return { keyId: BEARER_KEY_ID, provider: 'hermes', authScheme: 'bearer' };
}

/**
 * Auth middleware factory. `endpoint` is the audit/capability endpoint for the
 * mounted route — a string, or a function (req) => string for routers that
 * serve both claim and report.
 */
function linkWorkerAuth(endpoint) {
  return async function linkWorkerAuthMiddleware(req, res, next) {
    try {
      if (!isEnabled('hermesWorker')) {
        return res.status(403).json({ error: 'hermes worker integration disabled' });
      }
      const ep = typeof endpoint === 'function' ? endpoint(req) : endpoint;
      const hasHmacHeaders = Boolean(req.headers['x-waves-key-id'] || req.headers['x-waves-signature']);
      const identity = hasHmacHeaders ? await verifyHmac(req, ep) : verifyBearer(req);
      if (identity.status) return res.status(identity.status).json({ error: identity.error });
      if (identity.authScheme === 'bearer' && !BEARER_ENDPOINTS.includes(ep)) {
        return res.status(403).json({ error: 'endpoint not permitted for this key' });
      }

      // §3.4c: the audit row is INSERTED (result='authenticated') before the
      // handler runs, in its own statement, so an empty claim — or a handler
      // crash — still leaves evidence. The handler finalizes it below.
      const [row] = await db('seo_link_worker_requests')
        .insert({
          key_id: identity.keyId,
          provider: identity.provider,
          auth_scheme: identity.authScheme,
          method: req.method.toUpperCase(),
          path: req.baseUrl + req.path,
          query: Object.keys(req.query || {}).length ? JSON.stringify(req.query) : null,
          endpoint: ep,
          nonce: identity.nonce || null,
        })
        .returning('id');
      req.linkWorker = { provider: identity.provider, authScheme: identity.authScheme, keyId: identity.keyId };
      req.linkWorkerRequestId = row && (row.id || row);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Handler-side finalization of the pre-inserted audit row. Never throws;
 * resolves true when the row was updated and false otherwise, so a caller for
 * whom the row IS the payload (the watchdog heartbeat) can refuse to claim
 * success — every existing caller ignores the value and stays best-effort.
 */
async function finalizeWorkerRequest(req, result, extra = {}) {
  if (!req.linkWorkerRequestId) return false;
  try {
    const updated = await db('seo_link_worker_requests')
      .where({ id: req.linkWorkerRequestId })
      .update({ result, ...extra });
    return updated > 0;
  } catch (err) {
    logger.error('link-worker-auth audit finalize failed', { error: err.message, result });
    return false;
  }
}

module.exports = { linkWorkerAuth, finalizeWorkerRequest, rawBodyVerify, canonicalTarget, signCanonical, KEY_RECORDS };
