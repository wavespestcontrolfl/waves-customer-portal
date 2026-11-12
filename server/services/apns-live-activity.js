/**
 * Apple push for the Lock Screen visit card (an ActivityKit "Live Activity"), token-based (.p8) over HTTP/2.
 *
 * Three kinds of request, all signed with the provider token services/apns.js already keeps:
 *   start      POST /3/device/<push-to-start token>     push host    starts a card on ONE iPhone
 *   broadcast  POST /4/broadcasts/apps/<bundle id>       push host    updates or ends every card on a channel
 *   channel    POST | DELETE /1/apps/<bundle id>/channels manage host makes or removes a broadcast channel
 *
 * A card started with `input-push-channel` (iOS 18 and later) listens on that channel, so the server can
 * update it with no app running and no per-card token. The app id needs Apple's Broadcast Capability
 * (developer.apple.com → Identifiers → the app id → Push Notifications).
 *
 * Apple documents: "Starting and updating Live Activities with ActivityKit push notifications",
 * "Sending broadcast push notification requests to APNs", "Sending channel management requests to APNs".
 *
 * The app side of this contract is docs/mobile/live-activity.md. Every sender resolves, never rejects.
 */
const http2 = require('http2');
const apns = require('./apns');
const logger = require('./logger');

// The Swift ActivityAttributes type the card is built from. Apple matches this string to the type name in
// the app, so a rename here needs the same rename in the app and a new app version.
const ATTRIBUTES_TYPE = 'WavesVisitAttributes';

const PUSH_ORIGIN = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
// Channel management has its own hosts and ports (Apple: 2196 production, 2195 sandbox).
const MANAGE_ORIGIN = {
  production: 'https://api-manage-broadcast.push.apple.com:2196',
  sandbox: 'https://api-manage-broadcast.sandbox.push.apple.com:2195',
};

function environment() {
  return apns.status().production ? 'production' : 'sandbox';
}

function epochSeconds(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

/**
 * Pure: the JSON body for one card event.
 *   start  needs attributes, contentState, alert { title, body } (Apple requires an alert on a start) and
 *          the channel the new card listens on; staleAt is when the card reads as out of date with no update.
 *   update needs contentState; staleAt as above.
 *   end    needs the final contentState; dismissAt is when the card leaves the Lock Screen (a past time = at once).
 */
function buildPayload({ event, now, contentState, attributes, alert, channelId, staleAt, dismissAt }) {
  const aps = { timestamp: epochSeconds(now), event, 'content-state': contentState };
  if (event === 'start') {
    aps['attributes-type'] = ATTRIBUTES_TYPE;
    aps.attributes = attributes;
    aps['input-push-channel'] = channelId;
    aps.alert = { title: alert.title, body: alert.body };
  }
  if (staleAt && event !== 'end') aps['stale-date'] = epochSeconds(staleAt);
  if (dismissAt && event === 'end') aps['dismissal-date'] = epochSeconds(dismissAt);
  return { aps };
}

/** Pure: the request that starts a card on one iPhone. */
function startRequest({ startToken, payload, expiresAt }) {
  const { bundleId } = apns.status();
  return {
    origin: PUSH_ORIGIN[environment()],
    method: 'POST',
    path: `/3/device/${startToken}`,
    headers: {
      'apns-topic': `${bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': String(epochSeconds(expiresAt)),
    },
    body: payload,
  };
}

/** Pure: the request that updates or ends every card listening on a channel. */
function broadcastRequest({ channelId, payload, expiresAt }) {
  const { bundleId } = apns.status();
  return {
    origin: PUSH_ORIGIN[environment()],
    method: 'POST',
    path: `/4/broadcasts/apps/${bundleId}`,
    headers: {
      'apns-channel-id': channelId,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': String(epochSeconds(expiresAt)),
    },
    body: payload,
  };
}

/**
 * Pure: the request that makes a channel. Storage policy 1 keeps the newest message (Apple: up to 8 hours),
 * so an iPhone that was offline still gets the current step when it comes back.
 */
function createChannelRequest() {
  const { bundleId } = apns.status();
  return {
    origin: MANAGE_ORIGIN[environment()],
    method: 'POST',
    path: `/1/apps/${bundleId}/channels`,
    headers: {},
    body: { 'message-storage-policy': 1, 'push-type': 'LiveActivity' },
  };
}

/** Pure: the request that removes a channel. Apple never reuses a channel id. */
function deleteChannelRequest({ channelId }) {
  const { bundleId } = apns.status();
  return {
    origin: MANAGE_ORIGIN[environment()],
    method: 'DELETE',
    path: `/1/apps/${bundleId}/channels`,
    headers: { 'apns-channel-id': channelId },
    body: null,
  };
}

/**
 * Send one request. Resolves with { ok, status, reason, headers } or { ok: false, skipped | retryable, reason }.
 * Bounded like apns.send: a hung connection fails the call instead of holding its caller.
 * `uncertain` marks a failure with no answer after the request may have left (a timeout, a dropped
 * connection): Apple may have taken it.
 */
function request({ origin, method, path, headers, body }) {
  return new Promise((resolve) => {
    if (!apns.status().configured) return resolve({ ok: false, skipped: true, reason: 'apns_not_configured' });
    let token;
    try {
      token = apns.providerToken();
    } catch (err) {
      return resolve({ ok: false, reason: `apns_sign_failed: ${err.message}` });
    }
    let client;
    try {
      client = http2.connect(origin);
    } catch (err) {
      return resolve({ ok: false, retryable: true, reason: err.message });
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockKiller);
      try { client.close(); } catch { /* noop */ }
      resolve(result);
    };
    const wallClockKiller = setTimeout(() => {
      try { client.destroy(); } catch { /* noop */ }
      finish({ ok: false, retryable: true, uncertain: true, reason: 'apns_timeout' });
    }, apns.APNS_REQUEST_TIMEOUT_MS);
    client.on('error', (err) => finish({ ok: false, retryable: true, uncertain: true, reason: err.message }));
    try {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = client.request({
        ':method': method,
        ':path': path,
        authorization: `bearer ${token}`,
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      });
      let status = 0;
      let responseHeaders = {};
      let data = '';
      req.on('response', (h) => { status = h[':status']; responseHeaders = h; });
      req.setEncoding('utf8');
      req.on('data', (chunk) => { data += chunk; });
      req.on('error', (err) => finish({ ok: false, retryable: true, uncertain: true, reason: err.message }));
      req.on('end', () => {
        let reason = null;
        if (data) { try { reason = JSON.parse(data).reason || null; } catch { /* non-JSON body */ } }
        finish({ ok: status >= 200 && status < 300, status, reason, headers: responseHeaders });
      });
      if (payload) req.end(payload); else req.end();
    } catch (err) {
      finish({ ok: false, reason: err.message });
    }
  });
}

// What a caller may do with a failure:
//   retryable  it can pass by itself: no answer, a busy Apple (429) or an Apple fault (5xx).
//   uncertain  no answer came back after the request may have left, so Apple may have taken it. A caller
//              must not treat it as refused.
// Any other failure is Apple's refusal of this request, and sending it again changes nothing.
function failure(kind, result) {
  const reason = result.reason || `apns_status_${result.status || 0}`;
  if (!result.skipped) logger.error(`[apns-live-activity] ${kind} failed status=${result.status || 0} reason=${reason}`);
  const retryable = Boolean(result.retryable) || result.status === 429 || result.status >= 500;
  return {
    ok: false,
    reason,
    ...(result.skipped ? { skipped: true } : {}),
    ...(retryable ? { retryable: true } : {}),
    ...(result.uncertain ? { uncertain: true } : {}),
  };
}

/**
 * Start a card on one iPhone. `expired: true` means Apple says the start token is dead (410): the caller
 * clears it. `uncertain: true` means no answer came back, so the card may be on the phone. A 400 BadDeviceToken is NOT treated as dead, for the reason apns.js gives: Apple also returns
 * it for a host or bundle mismatch, and one wrong setting must not wipe every phone's token.
 */
async function start({ startToken, payload, expiresAt }, send = request) {
  const result = await send(startRequest({ startToken, payload, expiresAt }));
  if (result.ok) return { ok: true };
  return { ...failure('start', result), ...(result.status === 410 ? { expired: true } : {}) };
}

/** Update or end every card on a channel. */
async function broadcast({ channelId, payload, expiresAt }, send = request) {
  const result = await send(broadcastRequest({ channelId, payload, expiresAt }));
  return result.ok ? { ok: true } : failure('broadcast', result);
}

/** Make a channel. Apple returns its id in the `apns-channel-id` response header. */
async function createChannel(send = request) {
  const result = await send(createChannelRequest());
  const channelId = result.ok ? result.headers?.['apns-channel-id'] : null;
  if (channelId) return { ok: true, channelId: String(channelId) };
  return failure('channel create', result.ok ? { ...result, reason: 'no_channel_id' } : result);
}

/** Remove a channel. A 404 means it is already gone, which is the wanted end state. */
async function deleteChannel({ channelId }, send = request) {
  const result = await send(deleteChannelRequest({ channelId }));
  if (result.ok || result.status === 404) return { ok: true };
  return failure('channel delete', result);
}

module.exports = {
  ATTRIBUTES_TYPE,
  start,
  broadcast,
  createChannel,
  deleteChannel,
  // exported for unit tests
  buildPayload,
  startRequest,
  broadcastRequest,
  createChannelRequest,
  deleteChannelRequest,
};
