import { releaseInAppPush } from '../native/wavesAdminPush';

// Staff data saved on the device for offline use (the technician's last
// route, routeSnapshot.js). It carries customer names, addresses and access
// notes, so EVERY path that ends a staff session must call
// clearStaffDeviceData() next to removing the token.
export const TECH_ROUTE_SNAPSHOT_KEY = 'waves_tech_route_snapshot';
// The one record that may unlock the tech shell with no signal: the profile
// /admin/auth/me returned, bound to the exact token it verified (the JWT
// signature segment). A token written without its profile (a failed write,
// another login) or an expired token never matches, so no stale profile —
// and no stale route — opens offline.
export const STAFF_OFFLINE_PASS_KEY = 'waves_tech_offline_pass';
// Ask (Intelligence Bar) prompt text saved on the device: the palette's recent
// prompts (`${ASK_RECENTS_KEY}:<staff id>`, and the older key shared by every
// login) and the page bar's per-page recents (utils/ibStorage.js). A prompt
// can name a customer or a private business question. The staff id is gone
// by the time a session ends, so every login's prompts go, by key prefix.
// Pinned prompts are deliberate saves kept per login (ib.pinned.<staff id>.*)
// and stay; the older pinned lists shared by every login (ib.favorites.*) go.
export const ASK_RECENTS_KEY = 'admin_ib_recents';
const ASK_PROMPT_KEY_PREFIXES = [ASK_RECENTS_KEY, 'ib.recents.', 'ib.favorites.'];

export function clearStaffDeviceData() {
  // Waves Admin (the iOS staff app): this iPhone stops getting staff alerts.
  void releaseInAppPush();
  for (const key of [TECH_ROUTE_SNAPSHOT_KEY, STAFF_OFFLINE_PASS_KEY]) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && ASK_PROMPT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
}

function tokenBinding(token) {
  const parts = String(token || '').split('.');
  return parts.length === 3 && parts[2] ? parts[2] : null;
}

function tokenUnexpired(token, now = Date.now()) {
  try {
    const segment = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
    return typeof exp === 'number' && exp * 1000 > now;
  } catch {
    return false;
  }
}

// Pass format version. 2 = written by a build that checks the two-step
// sign-in policy (GATE_ADMIN_MFA) on the profile it verified; a pass from an
// older build (no version) never unlocks Today — the next online check
// writes a new one.
export const STAFF_OFFLINE_PASS_VERSION = 2;

export function saveStaffOfflinePass(token, profile) {
  const binding = tokenBinding(token);
  try {
    if (!binding || profile?.mustChangePassword || profile?.twoStep?.enrollmentRequired) throw new Error('not eligible');
    localStorage.setItem(STAFF_OFFLINE_PASS_KEY, JSON.stringify({ v: STAFF_OFFLINE_PASS_VERSION, binding, profile }));
  } catch {
    try { localStorage.removeItem(STAFF_OFFLINE_PASS_KEY); } catch { /* storage unavailable */ }
  }
}

// The verified profile for THIS token, or null: no pass, another token's
// pass, an expired or malformed token, a non-staff role or a forced reset.
export function loadStaffOfflinePass(token, now = Date.now()) {
  try {
    const binding = tokenBinding(token);
    const pass = JSON.parse(localStorage.getItem(STAFF_OFFLINE_PASS_KEY) || 'null');
    const profile = pass?.profile;
    if (pass?.v !== STAFF_OFFLINE_PASS_VERSION) return null;
    if (!binding || pass?.binding !== binding || !tokenUnexpired(token, now)) return null;
    if (!profile?.id || !['admin', 'technician'].includes(profile.role) || profile.mustChangePassword) return null;
    if (profile.twoStep?.enrollmentRequired) return null;
    return profile;
  } catch {
    return null;
  }
}

export function getAdminAuthToken() {
  return localStorage.getItem('waves_admin_token') || '';
}

export function getAdminUser() {
  try {
    const raw = localStorage.getItem('waves_admin_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getAdminDisplayName(fallback = 'Tech') {
  const user = getAdminUser();
  return user?.name || localStorage.getItem('techName') || localStorage.getItem('adminName') || fallback;
}
