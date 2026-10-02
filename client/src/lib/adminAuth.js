// Staff data saved on the device for offline use (the technician's last
// route, routeSnapshot.js). It carries customer names, addresses and access
// notes, so EVERY path that ends a staff session must call
// clearStaffDeviceData() next to removing the token.
export const TECH_ROUTE_SNAPSHOT_KEY = 'waves_tech_route_snapshot';

export function clearStaffDeviceData() {
  try { localStorage.removeItem(TECH_ROUTE_SNAPSHOT_KEY); } catch { /* storage unavailable */ }
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
