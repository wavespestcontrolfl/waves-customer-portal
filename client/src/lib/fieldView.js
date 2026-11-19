import { getAdminAuthToken, loadStaffOfflinePass } from './adminAuth';
import { preloadInBackground } from './staleChunkReload';

// Field view (owner 2026-11-19): an admin login can make the phone open on
// Today. The switch is saved on that phone, for that login only, with the
// other saved menu settings (key `waves_admin_navigation:<accountId>`).
// Everything here reads device storage only, so it can run before the admin
// shell checks the login with the server.

export const adminNavigationPreferenceKey = (accountId) => `waves_admin_navigation:${accountId}`;

// A missing, malformed or non-boolean value reads as off.
export function readFieldViewPreference(accountId, storage) {
  if (!accountId) return false;
  try {
    const saved = JSON.parse((storage || localStorage).getItem(adminNavigationPreferenceKey(accountId)) || '{}');
    return saved?.fieldView === true;
  } catch { return false; }
}

// The landing page of an open of /admin, before the shell checks the login.
// That early move exists for one case: with no signal the shell can open
// Today alone, from the offline pass a verified check left for THIS token.
// So it moves only when that pass would open (this token, unexpired, an
// admin profile) and that login's saved switch is on. In any other case (no
// pass, an expired token, another token's pass) it returns null: the shell
// checks the login at /admin, a sign-in it asks for returns there, and the
// index rule (AdminIndexRedirect) lands the verified login by its own switch.
export function fieldViewLanding(pathname) {
  const target = String(pathname || '').toLowerCase().replace(/\/$/, '');
  if (target !== '/admin') return null;
  try {
    const profile = loadStaffOfflinePass(getAdminAuthToken());
    if (profile?.role !== 'admin') return null;
    return readFieldViewPreference(profile.id) ? '/admin/today' : null;
  } catch { return null; }
}

// Today's code loads on first use, and the service worker keeps a page's
// code only after the app asked for it once. So turning Field view on loads
// Today's code at once: the next open can then show Today with no signal.
// Resolves false when the code could not load (no signal, or a newer build).
export function preloadFieldViewLanding() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
  return preloadInBackground([
    () => import('../pages/admin/TodayShell'),
    () => import('../pages/tech/TechHomePage'),
  ]);
}

// Router state on the Today address a Field view landing opened.
export const FIELD_VIEW_LANDING_STATE = Object.freeze({ fieldViewLanding: true });

// The address a sign-in returns to. Today opened by a Field view landing
// returns to /admin, so the login that signs in next lands by its own
// switch; any other address (Today opened by hand too) returns to itself.
export function signInReturnLocation(location) {
  return location?.state?.fieldViewLanding === true ? { pathname: '/admin', search: '', hash: '' } : location;
}
