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
// it. This asks the worker for each of Today's files that this build listed
// (fieldViewAssets.js), and those the worker's saved shell lists, then
// checks that the worker stored every one. It asks
// for the stored files too: the worker answers those from storage and claims
// each for this build as it does, or its prune drops a file once the builds
// that stored it are two deploys old. It fetches the files and never imports
// them: a failed import() leaves Vite treating Today's CSS as loaded for the
// rest of the tab, and Today's code does not run early.
// The worker writes one file at a time, so a slow phone gets about 3 s.
const STORE_CHECKS = 10;
const STORE_CHECK_MS = 300;
// A download that stalls on a weak signal must not hold the try open: after
// 60 s the rest are cancelled, and the try reads false.
const DOWNLOAD_MS = 60000;
// The shell remounts the provider on every page change, and each mount asks
// again. A failed try answers those calls for 5 minutes before one runs
// again: with full storage, every try downloads the files it cannot store.
const RETRY_MS = 5 * 60 * 1000;
let pageWarm = null;
let failedAt = 0;
// The saved shell's list (JSON) that the page's try found ready.
let readyShell = null;

async function unstored(files) {
  const stored = await Promise.all(files.map((file) => caches.match(file).then(Boolean, () => false)));
  return files.filter((_, index) => !stored[index]);
}

async function downloadAll(files) {
  const abort = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, DOWNLOAD_MS); });
  const downloads = files.map((file) => fetch(file, abort ? { signal: abort.signal } : undefined)
    .then((response) => response.arrayBuffer())
    .catch(() => null));
  await Promise.race([Promise.all(downloads), deadline]);
  clearTimeout(timer);
  abort?.abort();
}

// An open with no signal gets the shell the worker saved last ('/'), and it
// can be another build than this page: a tab that loaded a newer deploy
// replaced it, or the worker has not saved this page's build yet (or could
// not). So Today is ready only when the phone holds that shell's Today files
// as well as this page's. With no readable list there (none saved, a build
// from before Field view), Today is not ready; a try still asks for this
// page's files, which the next saved shell may list. This returns the saved
// shell's list, or null.
async function savedShellFiles() {
  try {
    const shell = await caches.match('/');
    return shell ? readFieldViewAssets(new DOMParser().parseFromString(await shell.text(), 'text/html')) : null;
  } catch {
    return null;
  }
}
const bothLists = (pageFiles, shellFiles) => [...new Set([...pageFiles, ...(shellFiles || [])])];

// Resolves the saved shell's list as JSON when the phone holds every file of
// both lists, and null when it does not.
async function warmTodayFiles(pageFiles) {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const shellFiles = await savedShellFiles();
  const files = bothLists(pageFiles, shellFiles);
  await downloadAll(files);
  // The worker stores a file after it answered the request.
  let missing = await unstored(files);
  for (let check = 0; missing.length && check < STORE_CHECKS; check += 1) {
    await new Promise((resolve) => { setTimeout(resolve, STORE_CHECK_MS); });
    missing = await unstored(missing);
  }
  return shellFiles && !missing.length ? JSON.stringify(shellFiles) : null;
}

// With no signal nothing can download, so the answer is whether the phone
// already holds every file of both lists.
async function storedAlready(pageFiles) {
  if (typeof caches === 'undefined') return false;
  const shellFiles = await savedShellFiles();
  return Boolean(shellFiles) && (await unstored(bothLists(pageFiles, shellFiles))).length === 0;
}

// The newest try's answer, for the Settings row: true, false, or null (a try
// is running, none ran yet, or the dev server). An older try that ends after
// a newer one started never overwrites it.
let readiness = null;
let newestTry = 0;
const readinessListeners = new Set();
function setReadiness(value) {
  readiness = value;
  readinessListeners.forEach((listener) => listener());
}
export function fieldViewReadiness() {
  return readiness;
}
export function subscribeFieldViewReadiness(listener) {
  readinessListeners.add(listener);
  return () => { readinessListeners.delete(listener); };
}

// Resolves true when the phone holds every file, false when it does not (no
// worker in control yet, no readable saved shell, full storage, a stalled
// download, a file a newer deploy removed, or a build with no list), and
// null on the dev server, which has no list. With no signal it answers from
// storage alone, asks for nothing and keeps nothing. A call reuses the
// page's try while it runs, for 5 minutes after it failed, and after it
// worked while the saved shell is still the one it checked: another tab can
// save a newer deploy's shell without a new worker. The switch's own tap, a
// new worker and the signal returning (`again`) always try anew.
export function warmFieldViewLanding({ again = false } = {}) {
  if (!again && pageWarm) {
    if (readyShell) return savedShellFiles().then((shellFiles) => JSON.stringify(shellFiles) === readyShell || warmFieldViewLanding({ again: true }));
    if (!failedAt || Date.now() - failedAt < RETRY_MS) return pageWarm;
  }
  const tryId = ++newestTry;
  const answer = (ready) => {
    if (tryId === newestTry) setReadiness(ready);
    return ready;
  };
  setReadiness(null);
  const files = readFieldViewAssets();
  if (!files) return Promise.resolve(answer(import.meta.env.DEV ? null : false));
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return storedAlready(files).then(answer);
  failedAt = 0;
  readyShell = null;
  const warm = warmTodayFiles(files).catch(() => null).then((shell) => {
    if (pageWarm === warm) {
      if (shell) readyShell = shell;
      else failedAt = Date.now();
    }
    return answer(Boolean(shell));
  });
  pageWarm = warm;
  return warm;
}

// Router state on the Today address a Field view landing opened.
export const FIELD_VIEW_LANDING_STATE = Object.freeze({ fieldViewLanding: true });

// The address a sign-in returns to. Today opened by a Field view landing
// returns to /admin, so the login that signs in next lands by its own
// switch; any other address (Today opened by hand too) returns to itself.
export function signInReturnLocation(location) {
  return location?.state?.fieldViewLanding === true ? { pathname: '/admin', search: '', hash: '' } : location;
}
