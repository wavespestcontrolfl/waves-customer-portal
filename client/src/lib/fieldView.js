import { getAdminAuthToken, loadStaffOfflinePass } from './adminAuth';
import { readFieldViewAssets } from './fieldViewAssets';

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

// Field view opens on Today, so an open with no signal needs Today's code on
// the phone, and the service worker keeps a file only once the app asked for
// it. This asks for each of Today's files that this build listed
// (fieldViewAssets.js) and the phone lacks, then checks that the worker
// stored every one. It fetches the files and never imports them: a failed
// import() leaves Vite treating Today's CSS as loaded for the rest of the
// tab, and Today's code does not run early.
// The worker writes one file at a time, so a slow phone gets about 3 s.
const STORE_CHECKS = 10;
const STORE_CHECK_MS = 300;
let pageWarm = null;

async function unstored(files) {
  const stored = await Promise.all(files.map((file) => caches.match(file).then(Boolean, () => false)));
  return files.filter((_, index) => !stored[index]);
}

async function warmTodayFiles(files) {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return false;
  let missing = await unstored(files);
  if (!missing.length) return true;
  await Promise.all(missing.map((file) => fetch(file).then((response) => response.arrayBuffer()).catch(() => null)));
  // The worker stores a file after it answered the request.
  for (let check = 0; missing.length && check < STORE_CHECKS; check += 1) {
    await new Promise((resolve) => { setTimeout(resolve, STORE_CHECK_MS); });
    missing = await unstored(missing);
  }
  return missing.length === 0;
}

// Resolves true when the phone holds every file, false when it does not (no
// signal, no service worker, full storage, a file a newer deploy removed, or
// a build with no list), and null on the dev server, which has no list. A
// session tries once per page; the switch's own tap (`again`) tries anew. A
// try with no signal is not kept, so the next one with signal runs.
export function warmFieldViewLanding({ again = false } = {}) {
  const files = readFieldViewAssets();
  if (!files) return Promise.resolve(import.meta.env.DEV ? null : false);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
  if (again || !pageWarm) pageWarm = warmTodayFiles(files);
  return pageWarm;
}

// Router state on the Today address a Field view landing opened.
export const FIELD_VIEW_LANDING_STATE = Object.freeze({ fieldViewLanding: true });

// The address a sign-in returns to. Today opened by a Field view landing
// returns to /admin, so the login that signs in next lands by its own
// switch; any other address (Today opened by hand too) returns to itself.
export function signInReturnLocation(location) {
  return location?.state?.fieldViewLanding === true ? { pathname: '/admin', search: '', hash: '' } : location;
}
