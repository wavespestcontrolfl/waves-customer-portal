/**
 * Firebase Cloud Messaging (FCM) sender — HTTP v1 API.
 *
 * Delivers push to the native Android app (Capacitor shell). The browser/web-push
 * path is unchanged and lives in push-notifications.js; this module is only
 * reached for subscriptions with platform='android'. Mirrors apns.js (iOS).
 *
 * Auth uses the service-account → OAuth2 access-token flow via google-auth-library
 * (bundled with the existing `googleapis` dep — no new package). The token client
 * caches/refreshes the access token internally.
 *
 * Config (Railway env), read once at load:
 *   FCM_SERVICE_ACCOUNT — the Firebase service-account JSON (the file contents as a
 *                         single string; literal \n in private_key tolerated).
 */
const https = require('https');
const logger = require('./logger');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function readConfig() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT || '').trim();
  if (!raw) return {};
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch {
    logger.warn('[fcm] FCM_SERVICE_ACCOUNT is set but not valid JSON — Android push disabled');
    return {};
  }
  return {
    projectId: String(sa.project_id || '').trim(),
    clientEmail: String(sa.client_email || '').trim(),
    // Railway often stores the key with escaped newlines — normalize them.
    privateKey: String(sa.private_key || '').replace(/\\n/g, '\n'),
  };
}

const cfg = readConfig();
const configured = Boolean(cfg.projectId && cfg.clientEmail && cfg.privateKey);
if (configured) {
  logger.info(`[fcm] configured (project=${cfg.projectId})`);
} else {
  logger.warn('[fcm] not configured — Android push disabled (need FCM_SERVICE_ACCOUNT)');
}

// Lazily build the JWT client (defers the heavy googleapis require until the first
// Android push, and only when configured). The client caches the access token.
let jwtClient = null;
function getJwtClient() {
  if (!jwtClient) {
    // eslint-disable-next-line global-require
    const { google } = require('googleapis');
    jwtClient = new google.auth.JWT({
      email: cfg.clientEmail,
      key: cfg.privateKey,
      scopes: [FCM_SCOPE],
    });
  }
  return jwtClient;
}

async function getAccessToken() {
  const res = await getJwtClient().getAccessToken();
  return res && res.token;
}

/**
 * Pure: map our generic notification shape ({ title, body, url, badge, ...data })
 * into an FCM HTTP v1 message. Everything that isn't title/body rides along as
 * string `data` (FCM data values must be strings), mirroring the APNs top-level
 * data the Capacitor push listener reads.
 */
function buildFcmMessage(deviceToken, notification = {}) {
  const data = {};
  for (const [k, v] of Object.entries(notification)) {
    if (k === 'title' || k === 'body') continue;
    if (v === undefined || v === null) continue;
    data[k] = typeof v === 'string' ? v : String(v);
  }
  return {
    message: {
      token: deviceToken,
      notification: {
        title: notification.title || 'Waves',
        body: notification.body || '',
      },
      data,
      android: { priority: 'high', notification: { sound: 'default' } },
    },
  };
}

/**
 * Pure: classify an FCM v1 response. Only a genuinely unregistered token is
 * "expired" (deactivate the row). Auth/quota/payload/server errors are NOT token
 * expiry — fail soft, so one misconfig (bad service account, wrong project) can't
 * deactivate every Android subscription. Mirrors apns.js's 410-only rule.
 */
function classifyFcmResponse(status, errorCode) {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 404 || /UNREGISTERED/i.test(errorCode || '')) {
    return { ok: false, expired: true, reason: errorCode || 'unregistered' };
  }
  return { ok: false, expired: false, reason: errorCode || `fcm_status_${status || 0}` };
}

/**
 * Send one notification to one device token. Resolves (never rejects) with
 * { ok } | { skipped } | { expired } | { failed } — so a config mistake fails
 * soft and never aborts the surrounding send loop (sendToCustomer / sendToAdmins).
 */
function send(deviceToken, notification) {
  return new Promise((resolve) => {
    if (!configured) return resolve({ ok: false, skipped: true, reason: 'fcm_not_configured' });
    if (!deviceToken) return resolve({ ok: false, failed: true, reason: 'missing_device_token' });

    getAccessToken()
      .then((token) => {
        if (!token) return resolve({ ok: false, failed: true, reason: 'fcm_token_unavailable' });

        let body;
        try {
          body = Buffer.from(JSON.stringify(buildFcmMessage(deviceToken, notification)));
        } catch (err) {
          return resolve({ ok: false, failed: true, reason: err.message });
        }

        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

        try {
          const req = https.request(
            {
              method: 'POST',
              host: 'fcm.googleapis.com',
              path: `/v1/projects/${cfg.projectId}/messages:send`,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'content-length': body.length,
              },
            },
            (res) => {
              let data = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => { data += chunk; });
              res.on('end', () => {
                let errorCode = null;
                if (data) {
                  try {
                    const j = JSON.parse(data);
                    errorCode = j.error?.details?.[0]?.errorCode || j.error?.status || null;
                  } catch { /* non-JSON body */ }
                }
                const result = classifyFcmResponse(res.statusCode, errorCode);
                if (!result.ok && !result.expired) {
                  logger.error(`[fcm] send failed status=${res.statusCode} code=${errorCode}`);
                }
                finish(result);
              });
            },
          );
          req.on('error', (err) => finish({ ok: false, failed: true, reason: err.message }));
          req.end(body);
        } catch (err) {
          finish({ ok: false, failed: true, reason: err.message });
        }
      })
      .catch((err) => resolve({ ok: false, failed: true, reason: `fcm_auth_failed: ${err.message}` }));
  });
}

function status() {
  return {
    available: true,
    configured,
    projectId: cfg.projectId || null,
    error: configured ? null : 'fcm_env_missing',
  };
}

module.exports = {
  send,
  status,
  // exported for unit tests
  buildFcmMessage,
  classifyFcmResponse,
};
