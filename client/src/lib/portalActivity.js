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
// when the beacon failed. Nothing retries: activity is best-effort.
async function post(path, body) {
  try {
    const res = await api.sendActivityBeacon(path, body);
    if (res && res.enabled === false) serverDisabled = true;
    return res != null;
  } catch {
    return false; /* activity is best-effort */
  }
}

// Same-tab dedupe is per signed-in identity (customer + session family), so a
// logout / profile switch never inherits the previous customer's memo.
function currentIdentityKey() {
  try {
    const identity = tokenSessionIdentity(localStorage.getItem('waves_token'));
    return identity ? `${identity.customerId}|${identity.sessionId || ''}` : 'anon';
  } catch { return 'anon'; }
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

// One id per physical tap, made when the tap happens. The server keys the open
// on it (or on the bell notification id) forever, so a duplicate delivery of
// the same tap dedupes while a second tap of the same push type does not.
function newTapId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
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
 * Call BEFORE navigating: ONE keepalive request is issued synchronously, with
 * no parking, replay or retry. It is sent only when the tap's link names no
 * profile or names the signed-in one; a tap that targets a different profile
 * of the account records nothing (the open cannot be attributed to that
 * profile without holding it across the switch, which is exactly the
 * machinery this avoids). A beacon lost to the page navigation is an
 * uncounted open, an accepted undercount for a best-effort signal.
 */
export function reportPushOpen(data) {
  if (serverDisabled) return;
  const target = targetProfileOf(data?.url);
  if (target && target !== currentCustomerId()) return;
  const pick = (v) => (typeof v === 'string' && v ? v.slice(0, 80) : undefined);
  void post(PUSH_OPEN_PATH, {
    platform: platformHint(),
    notificationId: pick(data?.notificationId),
    tapId: newTapId(),
    tag: pick(data?.tag),
    category: pick(data?.category),
  });
}

/** Test seam: forget the session's memo. */
export function resetPortalActivityForTests() {
  serverDisabled = false;
  lastSent.clear();
}
