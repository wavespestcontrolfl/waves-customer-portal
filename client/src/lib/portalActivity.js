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
// MUST equal the server's page-view dedupe window (DEDUPE_MINUTES = 10 in
// server/services/customer-page-views.js): the server drops a repeat of the
// same tab inside that window, so a shorter memo here would spend a beacon on a
// revisit the server discards, and a longer one would leave a revisit
// unrecorded. Do not even send a repeat of the same tab sooner than this from
// the same page session.
export const RESEND_SAME_ROUTE_MS = 10 * 60 * 1000;

// Foreground heartbeat: stamps last_seen_at only (no page-view row). The write
// throttle is the SERVER's (the UPDATE's WHERE clause); the client only guards
// against a burst. It must stay well under the hook's one-minute probe, or a
// probe the server throttled would defer the next one past the server's window
// and leave an active customer looking stale (#5335).
const HEARTBEAT_BURST_GUARD_MS = 30 * 1000;

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

/** Record that the customer opened a portal tab. `route` is the tab id. */
export function reportPortalPageView(route, now = Date.now()) {
  if (serverDisabled || typeof route !== 'string' || !route) return;
  const key = `${currentIdentityKey()}|${route}`;
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < RESEND_SAME_ROUTE_MS) return;
  lastSent.set(key, now);
  // Deliberately does NOT advance the heartbeat memo: the server's own SQL
  // throttle may have refused this page-view's last_seen_at stamp, and the
  // periodic heartbeat must keep probing on its own 5-minute floor (#5335).
  void post(PAGE_VIEW_PATH, { route, platform: platformHint() });
}

/**
 * Keep last_seen_at fresh during a long visible session. The caller (the
 * portal hook) probes once a minute, only while the page is visible AND the
 * customer has interacted recently; the server decides whether each probe
 * writes (a throttled probe is one no-op UPDATE). Hits a lightweight endpoint
 * that only stamps last_seen_at, so it never adds a tab-view row.
 */
export function reportPortalHeartbeat(now = Date.now()) {
  if (serverDisabled) return;
  const key = `${currentIdentityKey()}|heartbeat`;
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < HEARTBEAT_BURST_GUARD_MS) return;
  lastSent.set(key, now);
  void post(HEARTBEAT_PATH, {});
}

/**
 * Record that the app was opened from a push notification. `data` is the
 * Capacitor notification data; only the bell notificationId is sent (plus the
 * platform hint). The SERVER is the authority: it records the open only when
 * that notification belongs to the signed-in customer, and an open with no
 * notificationId (routed-SMS pushes carry only a type tag) or one owned by
 * another profile of the account records nothing. So the client never has to
 * guess which profile a tap belongs to; a bare push delivered for profile A and
 * tapped after switching to profile B is simply not counted.
 * Call BEFORE navigating: ONE keepalive request is issued synchronously, with
 * no parking, replay or retry. It is skipped only when the tap's link names a
 * different profile than the signed-in one (a request that could never
 * confirm). A beacon lost to the page navigation is an uncounted open, an
 * accepted undercount for a best-effort signal.
 */
export function reportPushOpen(data) {
  if (serverDisabled) return;
  const target = targetProfileOf(data?.url);
  if (target && target !== currentCustomerId()) return;
  const id = data?.notificationId;
  void post(PUSH_OPEN_PATH, {
    platform: platformHint(),
    notificationId: typeof id === 'string' && id ? id.slice(0, 80) : undefined,
  });
}

/** Test seam: forget the session's memo. */
export function resetPortalActivityForTests() {
  serverDisabled = false;
  lastSent.clear();
}
