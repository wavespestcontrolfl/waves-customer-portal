/**
 * Portal / app activity beacons (server gate GATE_PORTAL_ACTIVITY).
 *
 * Fire-and-forget: nothing here awaits on the render path, throws, or blocks
 * navigation. The server answers { enabled: false } while the gate is dark;
 * the first such answer switches every beacon off for the rest of the page
 * session (the gate has no other client-visible flag), so a dark gate costs
 * one tiny request per session. Only the portal tab id is sent for a page
 * view — never a path, id, token or query string — plus the Capacitor
 * platform hint ('web' | 'ios' | 'android').
 */
import api, { tokenSessionIdentity } from '../utils/api';
import { nativePlatform } from '../native/platform';

const PAGE_VIEW_PATH = '/customer/activity/page-view';
const PUSH_OPEN_PATH = '/customer/activity/push-open';
const HEARTBEAT_PATH = '/customer/activity/heartbeat';
// The server dedupes a tab view for 10 minutes; do not even send a repeat of
// the same tab sooner than this from the same page session.
const RESEND_SAME_ROUTE_MS = 5 * 60 * 1000;

// A push tap navigates the whole page (location.assign), which can cancel the
// beacon or strand its 401-refresh retry. The open is kept here until a beacon
// is answered, and flushed on the next portal mount. Stale entries are dropped,
// and an entry is bound to the session that tapped it: a different sign-in on
// the same device never replays it (it would be recorded against the wrong
// customer).
const PENDING_PUSH_OPEN_KEY = 'waves_pending_push_open';
const PENDING_PUSH_OPEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A tap that names another profile of a multi-profile account (the link's
// notificationProperty) is held until ProtectedRoute has switched the session
// to that profile, then sent with the target profile's token. If the switch
// never happens the open is dropped quickly rather than being credited to that
// profile whenever the customer happens to switch there by hand later.
const PENDING_TARGETED_OPEN_MAX_AGE_MS = 10 * 60 * 1000;

// Foreground heartbeat: stamps last_seen_at only (no page-view row), at most
// this often per signed-in identity. The page-view beacon also stamps
// last_seen_at, so it counts as a heartbeat for this throttle.
const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000;

let serverDisabled = false;
const lastSent = new Map();

function platformHint() {
  const platform = nativePlatform();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

// Resolves true when the server answered (recorded, filtered or gate-off), false
// when the beacon failed and may be worth retrying.
async function post(path, body) {
  try {
    const res = await api.sendActivityBeacon(path, body);
    if (res && res.enabled === false) serverDisabled = true;
    return res != null;
  } catch {
    return false; /* activity is best-effort */
  }
}

// The signed-in session's identity: the refresh family when the token has one
// (it survives token rotation and same-account profile switches), else the
// customer id. Null when signed out.
function currentSessionKey() {
  try {
    const identity = tokenSessionIdentity(localStorage.getItem('waves_token'));
    return identity ? (identity.sessionId || identity.customerId) : null;
  } catch { return null; }
}

// Same-tab dedupe is per signed-in identity (customer + session family), so a
// logout / profile switch never inherits the previous customer's memo.
function currentIdentityKey() {
  try {
    const identity = tokenSessionIdentity(localStorage.getItem('waves_token'));
    return identity ? `${identity.customerId}|${identity.sessionId || ''}` : 'anon';
  } catch { return 'anon'; }
}

let pendingSeq = 0;
function newPendingId() {
  pendingSeq += 1;
  return `${Date.now().toString(36)}-${pendingSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

// The customer id of the signed-in profile (changes on a profile switch).
function currentCustomerId() {
  try { return tokenSessionIdentity(localStorage.getItem('waves_token'))?.customerId || null; } catch { return null; }
}

// The profile a notification link asks the portal to open (see
// resolveNotificationTarget in App.jsx), or null for a link that names none.
function targetProfileOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try { return new URL(url, 'https://portal.invalid').searchParams.get('notificationProperty') || null; } catch { return null; }
}

// One id per physical tap, made when the tap happens and stored in the parked
// body so every retry of that tap carries the same one (the server keys the
// open on it: a retry dedupes, a second tap of the same push type does not).
function newTapId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// Returns the stored entry's id, or null when nothing was parked.
function storePendingPushOpen(body, targetCustomerId = null) {
  const session = currentSessionKey();
  if (!session) return null; // nobody signed in to attribute it to — send-only, never replayed
  const id = newPendingId();
  try {
    const entry = { id, body, session, at: Date.now() };
    if (targetCustomerId) entry.targetCustomerId = targetCustomerId;
    localStorage.setItem(PENDING_PUSH_OPEN_KEY, JSON.stringify(entry));
  } catch { return null; /* storage unavailable */ }
  return id;
}

function readPendingPushOpen() {
  try { return JSON.parse(localStorage.getItem(PENDING_PUSH_OPEN_KEY) || 'null'); } catch { return null; }
}

function clearPendingPushOpen() {
  try { localStorage.removeItem(PENDING_PUSH_OPEN_KEY); } catch { /* storage unavailable */ }
}

// Clear the parked entry only when it is still the one this request carried: an
// older request finishing late must not delete a newer open parked meanwhile.
function clearPendingPushOpenIf(id) {
  if (!id) return;
  if (readPendingPushOpen()?.id === id) clearPendingPushOpen();
}

async function sendPushOpen(body, id) {
  if (await post(PUSH_OPEN_PATH, body)) clearPendingPushOpenIf(id);
}

/** Record that the customer opened a portal tab. `route` is the tab id. */
export function reportPortalPageView(route, now = Date.now()) {
  if (serverDisabled || typeof route !== 'string' || !route) return;
  const key = `${currentIdentityKey()}|${route}`;
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < RESEND_SAME_ROUTE_MS) return;
  lastSent.set(key, now);
  lastSent.set(`${currentIdentityKey()}|heartbeat`, now); // the page-view stamps last_seen_at too
  void post(PAGE_VIEW_PATH, { route, platform: platformHint() });
}

/**
 * Keep last_seen_at fresh during a long visible session. The caller (the
 * portal hook) only calls this while the page is visible AND the customer has
 * interacted recently; this enforces the 5-minute floor. Hits a lightweight
 * endpoint that only stamps last_seen_at, so it never adds a tab-view row.
 */
export function reportPortalHeartbeat(now = Date.now()) {
  if (serverDisabled) return;
  const key = `${currentIdentityKey()}|heartbeat`;
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < HEARTBEAT_MIN_INTERVAL_MS) return;
  lastSent.set(key, now);
  void post(HEARTBEAT_PATH, {});
}

/**
 * Record that the app was opened from a push notification. `data` is the
 * Capacitor notification data: notificationId (bell pushes), tag and category
 * ride along from the server payload; anything missing is simply omitted.
 * Call BEFORE navigating: the request is issued synchronously (keepalive) and
 * the open is also parked in storage until a beacon is answered. Exception: a
 * tap whose link names a DIFFERENT profile of the account than the one signed
 * in is only parked; the portal's mount flush sends it once ProtectedRoute has
 * switched to that profile, so it is attributed with the right profile's token.
 */
export function reportPushOpen(data) {
  if (serverDisabled) return;
  const pick = (v) => (typeof v === 'string' && v ? v.slice(0, 80) : undefined);
  const body = {
    platform: platformHint(),
    notificationId: pick(data?.notificationId),
    tapId: newTapId(),
    tag: pick(data?.tag),
    category: pick(data?.category),
  };
  const target = targetProfileOf(data?.url);
  const current = currentCustomerId();
  if (target && current && target !== current) {
    storePendingPushOpen(body, target); // sent by flushPendingPushOpen after the profile switch
    return;
  }
  void sendPushOpen(body, storePendingPushOpen(body));
}

/** Retry a push open whose beacon never got an answer (call on portal mount). */
export function flushPendingPushOpen(now = Date.now()) {
  if (serverDisabled) return;
  const pending = readPendingPushOpen();
  if (!pending?.body) return;
  if (!pending.session || pending.session !== currentSessionKey()
    || !Number.isFinite(pending.at) || now - pending.at > PENDING_PUSH_OPEN_MAX_AGE_MS) {
    clearPendingPushOpen();
    return;
  }
  if (pending.targetCustomerId) {
    // A targeted open is only good for a short window after the tap, whether or
    // not the session now matches: a switch that failed must not leave an open
    // to be credited hours later when the customer switches there by hand.
    if (now - pending.at > PENDING_TARGETED_OPEN_MAX_AGE_MS) {
      clearPendingPushOpen();
      return;
    }
    // Waiting on the profile switch. Portal mount only happens after it, so a
    // mismatch here means the switch failed or the customer went elsewhere.
    if (pending.targetCustomerId !== currentCustomerId()) return;
  }
  void sendPushOpen(pending.body, pending.id);
}

/** Test seam: forget the session's memo. */
export function resetPortalActivityForTests() {
  serverDisabled = false;
  lastSent.clear();
  clearPendingPushOpen();
}
