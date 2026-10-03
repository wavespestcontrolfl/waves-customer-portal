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

export function clearStaffDeviceData() {
  for (const key of [TECH_ROUTE_SNAPSHOT_KEY, STAFF_OFFLINE_PASS_KEY]) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  }
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

export function saveStaffOfflinePass(token, profile) {
  const binding = tokenBinding(token);
  try {
    if (!binding || profile?.mustChangePassword || profile?.twoStep?.enrollmentRequired) throw new Error('not eligible');
    localStorage.setItem(STAFF_OFFLINE_PASS_KEY, JSON.stringify({ binding, profile }));
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
