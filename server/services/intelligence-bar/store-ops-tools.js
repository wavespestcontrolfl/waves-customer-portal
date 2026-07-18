/**
 * Intelligence Bar — App-Store Status Ops Tools
 * server/services/intelligence-bar/store-ops-tools.js
 *
 * Read-only visibility into app-store release state: App Store Connect
 * version states (READY_FOR_SALE, IN_REVIEW, REJECTED...) and Google Play
 * track releases, so "are the apps approved yet?" is answerable during
 * release windows without dashboard spelunking.
 *
 * Auth:
 * - Apple: ASC_KEY_ID + ASC_ISSUER_ID + ASC_PRIVATE_KEY (the .p8 content) —
 *   a short-lived ES256 JWT is minted per call. ASC_APP_ID defaults to the
 *   portal app.
 * - Google: PLAY_SERVICE_ACCOUNT_JSON (service-account key JSON, string).
 *   PLAY_PACKAGE_NAME defaults to the portal package. Track state is read
 *   through the NON-edit release-summary endpoint
 *   applications.tracks.releases.list
 *   (GET .../v3/applications/{package}/tracks/{track}/releases), which
 *   returns each release's releaseLifecycleState — including the review
 *   states (DRAFT / NOT_SENT_FOR_REVIEW / IN_REVIEW / APPROVED_NOT_PUBLISHED
 *   / NOT_APPROVED / PUBLISHED). This is a pure read: NO edit is created, so
 *   it (a) cannot invalidate an in-flight publishing edit, and (b) needs only
 *   read access ("View app information") on the service account — no release
 *   or edit permission. The installed googleapis client (v171) does not yet
 *   surface this method, so it is called via raw REST with a GoogleAuth
 *   access token.
 *
 *   NOTE: the Play half is pending first live validation — Play Console access
 *   for the service account is still being granted; the endpoint/URL/field
 *   mapping follow the androidpublisher v3 discovery contract.
 *
 * There are NO store mutations here — no submissions, no rollouts, no
 * metadata changes. Anything that mutates store state must go through the
 * write-gate mechanism (issue #1568) and is intentionally not built.
 */

const jwt = require('jsonwebtoken');
const logger = require('../logger');

const ASC_API_BASE = process.env.ASC_API_BASE || 'https://api.appstoreconnect.apple.com';
const PLAY_API_BASE = process.env.PLAY_API_BASE || 'https://androidpublisher.googleapis.com';
const DEFAULT_ASC_APP_ID = '6782775654'; // Waves customer portal iOS app
const DEFAULT_PLAY_PACKAGE = 'com.wavespestcontrol.portal';
const REQUEST_TIMEOUT_MS = 15000;
// Standard Play tracks to poll (there is no non-edit "list tracks" endpoint,
// so we query known track names and skip any that 404 for this app).
const PLAY_TRACKS = ['production', 'beta', 'alpha', 'internal'];
// releaseLifecycleState value meaning "available to users" (incl. partial
// rollout and resumable halted). Everything else is pending / in-review.
const PLAY_LIVE_STATE = 'RELEASE_LIFECYCLE_STATE_PUBLISHED';
// ASC's appStoreVersions relationship does NOT support a `sort` param (it
// returns HTTP 400 "The parameter 'sort' can not be used with this request",
// verified live), and it returns rows newest-first by default. Request a
// generous page so the live/in-review version is always in the returned set
// even for apps with many historical versions; we sort locally after.
const MAX_VERSIONS = 50;

// "Live on the App Store" has two spellings: the legacy appStoreState field
// says READY_FOR_SALE; the newer appVersionState field says
// READY_FOR_DISTRIBUTION. Treat both as live (and neither as in-flight).
const LIVE_STATES = ['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION'];
const NOT_IN_FLIGHT_STATES = [...LIVE_STATES, 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE'];

const STORE_OPS_TOOLS = [
  {
    name: 'get_app_store_status',
    description: `Get the App Store (iOS) release state: recent app versions with their App Store states — READY_FOR_SALE (live), WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, etc.
Use for: "is the iOS app approved yet?", "what version is live on the App Store?", "did Apple reject the build?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_play_store_status',
    description: `Get the Google Play release state: each track (production, beta, alpha, internal) with its releases, names, and lifecycle state — PUBLISHED (live/serving users), IN_REVIEW, APPROVED_NOT_PUBLISHED, NOT_APPROVED (rejected), NOT_SENT_FOR_REVIEW, DRAFT. Returns the live production release and any pending release separately.
Use for: "is the Android app live?", "what's on the Play production track?", "did the Play review finish?", "was the Android build rejected?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const ASC_NOT_CONFIGURED = 'App Store Connect access is not configured. Add ASC_KEY_ID, ASC_ISSUER_ID, and ASC_PRIVATE_KEY (the .p8 key content) service variables in the Railway dashboard.';
const PLAY_NOT_CONFIGURED = 'Google Play access is not configured. Add the PLAY_SERVICE_ACCOUNT_JSON service variable (a service-account key with "View app information" read access in Play Console) in the Railway dashboard.';

function ascConfigured() {
  return Boolean(process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID && process.env.ASC_PRIVATE_KEY);
}

function ascJwt() {
  // Railway often stores the .p8 with escaped newlines — normalize them
  // (same treatment as APNS_KEY in services/apns.js).
  const key = process.env.ASC_PRIVATE_KEY.trim().replace(/\\n/g, '\n');
  // Apple caps validity at 20 minutes; mint fresh per call and keep it short.
  return jwt.sign({}, key, {
    algorithm: 'ES256',
    issuer: process.env.ASC_ISSUER_ID,
    audience: 'appstoreconnect-v1',
    expiresIn: '10m',
    keyid: process.env.ASC_KEY_ID,
  });
}

async function ascGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ASC_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${ascJwt()}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('App Store Connect rejected the key — check ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY.');
    }
    if (!res.ok) throw new Error(`App Store Connect API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`App Store Connect API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getAppStoreStatus() {
  const appId = process.env.ASC_APP_ID || DEFAULT_ASC_APP_ID;
  const json = await ascGet(`/v1/apps/${appId}/appStoreVersions?limit=${MAX_VERSIONS}`);
  const versions = (json.data || []).map(v => ({
    version: v.attributes?.versionString,
    // Newer ASC responses use appVersionState; older use appStoreState.
    state: v.attributes?.appStoreState || v.attributes?.appVersionState || null,
    platform: v.attributes?.platform || null,
    created: v.attributes?.createdDate || null,
  }));
  // ASC does not guarantee ordering, and more than one row can be in a live
  // state (e.g. different platforms). Pick the NEWEST live version by created
  // date so "what's live?" is stable rather than response-order dependent.
  const live = versions
    .filter(v => LIVE_STATES.includes(v.state))
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))[0];
  const inFlight = versions.filter(v => v.state && !NOT_IN_FLIGHT_STATES.includes(v.state));
  return {
    app_id: appId,
    live_version: live?.version || null,
    in_flight: inFlight,
    versions,
    total: versions.length,
  };
}

// googleapis is required lazily so unit tests can mock it and the module
// stays cheap to load for the (default) unconfigured case.
function getGoogleapis() {
  // eslint-disable-next-line global-require
  return require('googleapis').google;
}

function maxVersionCode(release) {
  const codes = release?.version_codes || [];
  return codes.length ? Math.max(...codes) : 0;
}

async function playGet(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Google Play API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getPlayStoreStatus() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  const packageName = process.env.PLAY_PACKAGE_NAME || DEFAULT_PLAY_PACKAGE;
  const google = getGoogleapis();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  const token = typeof tokenResp === 'string' ? tokenResp : tokenResp?.token;
  if (!token) throw new Error('Could not obtain a Google Play access token from PLAY_SERVICE_ACCOUNT_JSON.');

  // No edit context: read each known track's release summaries directly. A
  // track not configured for this app 404s and is skipped — but if EVERY
  // track 404s the package/app access is almost certainly wrong, which must
  // surface as an error, not a successful "no releases" (see below).
  const tracks = [];
  let anyTrackFound = false;
  for (const track of PLAY_TRACKS) {
    const url = `${PLAY_API_BASE}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/tracks/${track}/releases`;
    const res = await playGet(url, token);
    if (res.status === 401 || res.status === 403) {
      throw new Error('Google Play rejected the service account — check PLAY_SERVICE_ACCOUNT_JSON has app access.');
    }
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Google Play API returned HTTP ${res.status} for track ${track}`);
    anyTrackFound = true; // a 2xx means the track exists (releases may be empty)
    const data = await res.json();
    const releases = (data.releases || []).map(r => ({
      name: r.releaseName || null,
      lifecycle_state: r.releaseLifecycleState || null,
      version_codes: (r.activeArtifacts || []).map(a => a.versionCode).filter(v => v != null),
    }));
    if (releases.length) tracks.push({ track, releases });
  }
  // All tracks 404 = wrong PLAY_PACKAGE_NAME or the SA can't see this app.
  // Surface it instead of a silent empty success that reads as "no release".
  if (!anyTrackFound) {
    throw new Error(`No Play tracks found for "${packageName}" — check PLAY_PACKAGE_NAME and that the service account has access to this app.`);
  }

  const production = tracks.find(t => t.track === 'production');
  const prodReleases = production?.releases || [];
  // Keep "is it live?" separate from "is a release pending?": the live release
  // is the PUBLISHED one currently serving users; the pending release is the
  // first non-published one (in review / approved-not-published / rejected /
  // draft). Both can coexist on the production track during a release window.
  // If several releases are PUBLISHED at once (e.g. an old fully-rolled-out
  // build plus a newer staged rollout), the newest by version code is "live".
  const published = prodReleases.filter(r => r.lifecycle_state === PLAY_LIVE_STATE);
  const liveRelease = published.sort((a, b) => maxVersionCode(b) - maxVersionCode(a))[0] || null;
  const pendingRelease = prodReleases.find(r => r.lifecycle_state && r.lifecycle_state !== PLAY_LIVE_STATE) || null;
  return {
    package: packageName,
    production_status: liveRelease?.lifecycle_state || null,
    production_release: liveRelease?.name || null,
    pending_release: pendingRelease,
    production_releases: prodReleases,
    tracks,
    total_tracks: tracks.length,
  };
}

async function executeStoreOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  try {
    switch (toolName) {
      case 'get_app_store_status':
        if (!ascConfigured()) return { configured: false, message: ASC_NOT_CONFIGURED };
        return await getAppStoreStatus();
      case 'get_play_store_status':
        if (!process.env.PLAY_SERVICE_ACCOUNT_JSON) return { configured: false, message: PLAY_NOT_CONFIGURED };
        return await getPlayStoreStatus();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    // Log ONLY the message/status — never the raw error object. Gaxios (Play)
    // errors carry the request config incl. the post-auth Authorization header,
    // so logging the object would leak the release-capable SA's bearer token.
    logger.error(`[intelligence-bar:store-ops] Tool ${toolName} failed: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { STORE_OPS_TOOLS, executeStoreOpsTool };
