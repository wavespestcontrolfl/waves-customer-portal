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
const jwt = require('jsonwebtoken');
const logger = require('./logger');

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
 * Pure: classify an APNs HTTP response. A dead token (410 Unregistered, or a
 * 400 BadDeviceToken/DeviceTokenNotForTopic) is reported as `expired` so the
 * caller deactivates the row — mirrors the web-push 410/404 handling.
 */
function classifyApnsResponse(status, reason) {
  if (status === 200) return { ok: true };
  if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic') {
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
      try { client.close(); } catch { /* noop */ }
      resolve(result);
    };

    client.on('error', (err) => finish({ ok: false, failed: true, reason: err.message }));

    const body = Buffer.from(JSON.stringify(buildApnsPayload(notification)));
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
      'content-length': body.length,
    });

    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('error', (err) => finish({ ok: false, failed: true, reason: err.message }));
    req.on('end', () => {
      let reason = null;
      if (data) { try { reason = JSON.parse(data).reason; } catch { /* non-JSON body */ } }
      const result = classifyApnsResponse(status, reason);
      if (!result.ok && !result.expired) logger.error(`[apns] send failed status=${status} reason=${reason}`);
      finish(result);
    });
    req.end(body);
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
};
