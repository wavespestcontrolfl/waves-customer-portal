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
 * - Google: PLAY_SERVICE_ACCOUNT_JSON (service-account key JSON, string) via
 *   googleapis; PLAY_PACKAGE_NAME defaults to the portal package. Reading
 *   track state requires the Play API's edit context: a DRAFT edit is
 *   inserted, tracks are read, and the edit is deleted without ever being
 *   committed — nothing observable changes in Play (this is the API's
 *   canonical read pattern; fastlane does the same). No edit is ever
 *   committed from this module.
 *
 *   PERMISSION: because the read goes through edits.insert, the service
 *   account needs a Play Console role that can CREATE an edit (a release
 *   role such as "Release apps to testing tracks" / "Manage production
 *   releases", or Admin). The pure read-only "View app information and
 *   download bulk reports" role CANNOT create the edit and this call would
 *   403 — do not provision the SA with only that role.
 *
 *   CONSTRAINT: Play invalidates a user's other active edits for the same
 *   app when a new edit is created, so PLAY_SERVICE_ACCOUNT_JSON must be a
 *   service account that is NOT shared with any Play publishing automation
 *   — a status check during a release window must never be able to discard
 *   an in-flight upload edit. (No Play publishing automation exists in this
 *   repo; releases are pushed from local tooling under a different user.
 *   If that ever changes, give this tool its own dedicated SA.)
 *
 * There are NO store mutations here — no submissions, no rollouts, no
 * metadata changes. Anything that mutates store state must go through the
 * write-gate mechanism (issue #1568) and is intentionally not built.
 */

const jwt = require('jsonwebtoken');
const logger = require('../logger');

const ASC_API_BASE = process.env.ASC_API_BASE || 'https://api.appstoreconnect.apple.com';
const DEFAULT_ASC_APP_ID = '6782775654'; // Waves customer portal iOS app
const DEFAULT_PLAY_PACKAGE = 'com.wavespestcontrol.portal';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_VERSIONS = 10;

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
    description: `Get the Google Play release state: each track (production, beta, internal) with its releases, version names, and status (completed = fully live, inProgress = staged rollout, draft...).
Use for: "is the Android app live?", "what's on the Play production track?", "did the Play review finish?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const ASC_NOT_CONFIGURED = 'App Store Connect access is not configured. Add ASC_KEY_ID, ASC_ISSUER_ID, and ASC_PRIVATE_KEY (the .p8 key content) service variables in the Railway dashboard.';
const PLAY_NOT_CONFIGURED = 'Google Play access is not configured. Add the PLAY_SERVICE_ACCOUNT_JSON service variable in the Railway dashboard. The service account needs a Play Console role that can create an edit (a release role, or Admin) — the read-only "View app information" role cannot read track state.';

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
  const publisher = google.androidpublisher({ version: 'v3', auth: await auth.getClient() });
  // googleapis/gaxios has NO default deadline — every call gets the module
  // timeout so a stalled Play call can't hang the Intelligence Bar loop.
  const callOpts = { timeout: REQUEST_TIMEOUT_MS };

  // Track state is only readable inside an edit context. The edit is a
  // DRAFT: inserted, read, then deleted — never committed, so nothing in
  // Play changes. Deletion failures are swallowed (uncommitted edits also
  // expire server-side on their own).
  const edit = await publisher.edits.insert({ packageName }, callOpts);
  const editId = edit.data.id;
  try {
    const tracks = await publisher.edits.tracks.list({ packageName, editId }, callOpts);
    const mapped = (tracks.data.tracks || []).map(t => ({
      track: t.track,
      releases: (t.releases || []).map(r => ({
        name: r.name,
        status: r.status,
        version_codes: r.versionCodes || [],
        user_fraction: r.userFraction ?? null,
      })),
    }));
    const production = mapped.find(t => t.track === 'production');
    const prodReleases = production?.releases || [];
    // A track can carry several releases at once (a completed live release PLUS
    // a draft / inProgress / halted one). For "did Play review finish?" the
    // pending release is the newsworthy one, so surface the first non-completed
    // release when present and fall back to the current live release otherwise.
    // (edits.tracks.list already returns releases across all statuses — draft,
    // inProgress, halted, completed — so pending builds are not dropped.)
    const prodActive = prodReleases.find(r => r.status && r.status !== 'completed') || prodReleases[0] || null;
    return {
      package: packageName,
      production_status: prodActive?.status || null,
      production_release: prodActive?.name || null,
      production_releases: prodReleases,
      tracks: mapped,
      total_tracks: mapped.length,
    };
  } finally {
    try {
      await publisher.edits.delete({ packageName, editId }, callOpts);
    } catch (cleanupErr) {
      logger.warn(`[intelligence-bar:store-ops] Play draft-edit cleanup failed (edit expires on its own): ${cleanupErr.message}`);
    }
  }
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
    logger.error(`[intelligence-bar:store-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { STORE_OPS_TOOLS, executeStoreOpsTool };
