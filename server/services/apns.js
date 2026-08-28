/**
 * Apple Push Notification service (APNs) sender — token-based (.p8) over HTTP/2.
 *
 * Delivers push to the native iOS app (Capacitor shell). The browser/web-push
 * path is unchanged and lives in push-notifications.js; this module is only
 * reached for subscriptions with platform='ios'.
 *
 * Uses Node's built-in http2 + jsonwebtoken (ES256) — no external APNs lib.
 *
 * Config (Railway env), read once at load (mirrors the VAPID block):
 *   APNS_KEY        — contents of AuthKey_XXXXXXXXXX.p8 (literal \n tolerated)
 *   APNS_KEY_ID     — the key's 10-char Key ID
 *   APNS_TEAM_ID    — Apple Developer Team ID
 *   APNS_BUNDLE_ID  — app bundle id (default com.wavespestcontrol.portal)
 *   APNS_PRODUCTION — 'true' → prod APNs host; otherwise sandbox
 */
const http2 = require('http2');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

// AMBIGUITY, deliberate: destroying after handoff cannot retract bytes
// the provider already accepted — the push may still deliver. Routing
// classifies timeouts as undelivered ON PURPOSE (at-least-once: a rare
// duplicate beats silent loss; see push-channel-routing.js rule 1).
// Bounded requests: a hung APNs connection must fail the send promptly —
// and destroying the stream also prevents a LATE delivery after a caller
// (push-channel-routing) has already taken its SMS fallback.
const APNS_REQUEST_TIMEOUT_MS = 8000;
const HOST_PROD = 'https://api.push.apple.com';
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

function readConfig() {
  return {
    // Railway often stores the .p8 with escaped newlines — normalize them.
    signingKey: (process.env.APNS_KEY || '').trim().replace(/\\n/g, '\n'),
    keyId: (process.env.APNS_KEY_ID || '').trim(),
    teamId: (process.env.APNS_TEAM_ID || '').trim(),
    bundleId: (process.env.APNS_BUNDLE_ID || 'com.wavespestcontrol.portal').trim(),
    production: String(process.env.APNS_PRODUCTION || '').trim().toLowerCase() === 'true',
  };
}

const cfg = readConfig();
const configured = Boolean(cfg.signingKey && cfg.keyId && cfg.teamId);
if (configured) {
  logger.info(`[apns] configured (team=${cfg.teamId}, key=${cfg.keyId}, bundle=${cfg.bundleId}, ${cfg.production ? 'prod' : 'sandbox'})`);
} else {
  logger.warn('[apns] not configured — iOS push disabled (need APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID)');
}

/**
 * Pure: sign an APNs provider JWT (ES256, with the kid header Apple requires).
 * Exported for unit testing with an injected key + iat.
 */
function signProviderToken({ signingKey, keyId, teamId, iat }) {
  return jwt.sign({ iss: teamId, iat }, signingKey, {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: keyId },
  });
}

// Apple accepts a provider token for up to 1h; refresh well inside that.
let cachedToken = null;
let cachedAtMs = 0;
function providerToken(nowMs = Date.now()) {
  if (cachedToken && nowMs - cachedAtMs < 50 * 60 * 1000) return cachedToken;
  cachedToken = signProviderToken({ ...cfg, iat: Math.floor(nowMs / 1000) });
  cachedAtMs = nowMs;
  return cachedToken;
}

/**
 * Pure: map our generic notification shape ({ title, body, url, badge, ...data })
 * into an APNs payload. Extra keys ride along as top-level data (read by the
 * Capacitor push listener in client/src/native/nativePush.js).
 */
/**
 * Pure: APNs `apns-collapse-id` for a push. Mirrors the web-push `tag`
 * contract — a redelivery with the same tag REPLACES the banner instead of
 * stacking a second one (a stale-lease retry after a crash, a re-fired
 * SMS bell). Apple caps the header at 64 bytes.
 */
function apnsCollapseId(tag) {
  if (!tag) return null;
  const s = String(tag);
  if (Buffer.byteLength(s) <= 64) return s;
  // Hash, never truncate: tags put the distinguishing suffix LAST (e.g.
  // customer id + decision id), so a prefix cut would collapse distinct
  // pushes into one (codex r6). sha256 hex is exactly 64 bytes.
  return crypto.createHash('sha256').update(s).digest('hex');
}

function buildApnsPayload(notification = {}) {
  const { title, body, badge, sound, url, aps: _ignore, ...rest } = notification;
  const aps = {
    alert: { title: title || 'Waves Pest Control', body: body || '' },
    sound: sound || 'default',
  };
  if (typeof badge === 'number') aps.badge = badge;
  const payload = { aps };
  if (url) payload.url = url;
  for (const [k, v] of Object.entries(rest)) payload[k] = v;
  return payload;
}

/**
 * Pure: classify an APNs HTTP response.
 *
 * Only `410 Unregistered` is treated as `expired` (deactivate the row) — that's
 * the one reliable "this token is dead" signal (app uninstalled / token rotated),
 * mirroring the web-push 410/404 handling. BadDeviceToken / DeviceTokenNotForTopic
 * are deliberately NOT expired: Apple also returns them for a server
 * environment/topic mismatch (wrong APNS_PRODUCTION host or APNS_BUNDLE_ID), so
 * deactivating on them would let one misconfig wipe every valid iOS subscription
 * on the first send. Those surface as a normal (non-expiring) failure instead.
 */
function classifyApnsResponse(status, reason) {
  if (status === 200) return { ok: true };
  if (status === 410 || reason === 'Unregistered') {
    return { ok: false, expired: true, reason: reason || 'unregistered' };
  }
  return { ok: false, expired: false, reason: reason || `apns_status_${status || 0}` };
}

/**
 * Send one notification to one device token. Resolves (never rejects) with
 * { ok } | { skipped } | { expired } | { failed }.
 */
function send(deviceToken, notification) {
  return new Promise((resolve) => {
    if (!configured) return resolve({ ok: false, skipped: true, reason: 'apns_not_configured' });
    if (!deviceToken) return resolve({ ok: false, failed: true, reason: 'missing_device_token' });

    // Build the provider token first — ES256 signing can throw on a malformed
    // .p8 (bad key / stray quotes). Resolve a failed result instead of letting
    // the promise reject, so a config mistake fails soft and never aborts the
    // surrounding send loop (sendToCustomer / sendToAdmins).
    let token;
    try {
      token = providerToken();
    } catch (err) {
      return resolve({ ok: false, failed: true, reason: `apns_sign_failed: ${err.message}` });
    }

    let client;
    try {
      client = http2.connect(cfg.production ? HOST_PROD : HOST_SANDBOX);
    } catch (err) {
      return resolve({ ok: false, failed: true, reason: err.message });
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockKiller);
      try { client.close(); } catch { /* noop */ }
      resolve(result);
    };
    // Same connection-phase gap as fcm.js: stream timers only run once the
    // session is connected — a DNS/TCP/TLS stall on http2.connect never
    // reaches them. destroy() fails the leg and prevents late delivery.
    const wallClockKiller = setTimeout(() => {
      try { client.destroy(); } catch { /* noop */ }
      finish({ ok: false, failed: true, reason: 'apns_timeout' });
    }, APNS_REQUEST_TIMEOUT_MS);

    client.on('error', (err) => finish({ ok: false, failed: true, reason: err.message }));

    // Any synchronous throw building/sending the request also fails soft.
    try {
      const body = Buffer.from(JSON.stringify(buildApnsPayload(notification)));
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        'apns-topic': cfg.bundleId,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
        'content-length': body.length,
      };
      const collapseId = apnsCollapseId(notification?.tag);
      if (collapseId) headers['apns-collapse-id'] = collapseId;
      const req = client.request(headers);

      let status = 0;
      let data = '';
      req.on('response', (headers) => { status = headers[':status']; });
      req.setEncoding('utf8');
      req.on('data', (chunk) => { data += chunk; });
      req.on('error', (err) => finish({ ok: false, failed: true, reason: err.message }));
      req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch { /* noop */ }
        finish({ ok: false, failed: true, reason: 'apns_timeout' });
      });
      req.on('end', () => {
        let reason = null;
        if (data) { try { reason = JSON.parse(data).reason; } catch { /* non-JSON body */ } }
        const result = classifyApnsResponse(status, reason);
        if (!result.ok && !result.expired) logger.error(`[apns] send failed status=${status} reason=${reason}`);
        finish(result);
      });
      req.end(body);
    } catch (err) {
      finish({ ok: false, failed: true, reason: err.message });
    }
  });
}

function status() {
  return {
    available: true,
    configured,
    production: cfg.production,
    bundleId: cfg.bundleId,
    error: configured ? null : 'apns_env_missing',
  };
}

module.exports = {
  send,
  status,
  // exported for unit tests
  signProviderToken,
  buildApnsPayload,
  classifyApnsResponse,
  apnsCollapseId,
};
