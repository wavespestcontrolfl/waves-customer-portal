// An out-of-date staff tab reloads once, at its next page move, so the page
// the user opens runs the live code (owner 2026-11-19, option A). App.jsx's
// PortalUpdateGate shows the loading placeholder while this runs, after the
// old page has closed: the move already dropped that page's state, so the
// reload loses nothing more. Work that outlives a move holds it
// (reloadHolds.js), and so does a request still open after 10 s: any API
// request, reads included (a read can be the first step of a send), or a
// write to the device's own storage (deviceWrites.js).
// Waves Admin never reloads by itself (a reload with no signal opens the
// app's offline screen), nor do the field pages (/admin/today must work with
// no signal), at a move to or away from one: field work can still be on its
// way as a field page closes, such as a time-clock punch waiting for the
// location. Both, like every staff page, get the Reload bar. No tab reloads
// by itself while the browser reports it is offline.
import { isAdminPath, isFieldPath, routerPath } from './adminBookmarkMeta';
import { deviceWritesInFlight } from './deviceWrites';
import { heardFromServerWithin, loadedBuild, newerBuild, requestsInFlight, writesInFlight } from './portalVersion';
import { reloadHoldName, reloadHoldNames } from './reloadHolds';
import { isWavesAdminApp } from '../native/platform';

export const RECENT_ANSWER_MS = 5 * 60 * 1000;
export const WRITE_WAIT_MS = 10 * 1000;
const RELOADED_FOR = 'portal-reloaded-for';
export const RELOAD_TRIES = 3;

// A use of a staff page: a tap, a key or an edit anywhere but on a Reload
// control (the Reload bar, PortalReloadPrompt, the staff retry screen in
// App.jsx). Unsaved work can follow a use, so a reload asks first: the
// Reload bar (components/PortalUpdate.jsx) and the stale-chunk reload
// (lib/staleChunkReload.js) count it the same way.
export const PAGE_USE_EVENTS = ['pointerdown', 'click', 'keydown', 'input', 'change'];
export function isPageUse(event) {
  return event.target instanceof Element
    && !event.target.closest('[data-portal-update-bar], [data-portal-reload-prompt]');
}

// The automatic reloads this tab made for this live build. A reload can come
// back on the old page: when the network fails at that moment, the service
// worker answers with its saved copy. So the tab may try again at a later
// move, up to three times for one build, and each try needs a recent answer
// from the new server (hasSignal), which a page that just loaded has not had
// yet. Without session storage the tab cannot count its tries (null), so it
// never reloads by itself.
function reloadTries(build) {
  try {
    const marker = JSON.parse(sessionStorage.getItem(RELOADED_FOR));
    if (marker?.build !== build) return 0;
    return Number.isInteger(marker.tries) ? marker.tries : null;
  } catch { return null; }
}

export const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// A reload with no connection swaps a working page for an offline error, so
// it needs a recent answer from the new server, and the browser must not
// report itself offline.
function hasSignal(now) {
  return !browserOffline() && heardFromServerWithin(RECENT_ANSWER_MS, now);
}

// The /admin index only redirects: to Today for a technician or with Field
// view on, else to the dashboard (AdminFieldViewEntry, AdminIndexRedirect).
// So a move to it is not a page move: the move on to the page it lands on
// decides. The gate judges that redirect, like every redirect, as part of the
// move it continues (PortalUpdateGate in components/PortalUpdate.jsx).
// The router matches it with any number of trailing slashes: /admin///.
const adminIndex = (pathname) => /^\/admin\/*$/.test(routerPath(pathname));

// Waves Admin never reloads by itself, nor does a field page, at a move to or
// away from one (see the top of this file). The stale-chunk reload asks it
// too (staleChunkReload.js).
export function selfReloadBarred(pathname, from = null) {
  return isFieldPath(pathname) || isFieldPath(from) || isWavesAdminApp();
}

// Why a move to `pathname` does not reload the tab, or null when the move is
// due a reload. `from`: the page the move leaves. The name says what stopped
// the reload first: a page that never reloads by itself ('not-staff',
// 'admin-index', 'waves-admin', 'field-page'), a tab that knows no newer
// build ('current', or 'never-heard' when no staff answer has named a build
// since the page loaded), then 'offline', 'no-signal', 'storage' (the tries
// cannot be counted), 'reloaded' (three tries spent), a hold's name and
// 'stalled'.
export function reloadBlockerAtMove(pathname, now = Date.now(), from = null) {
  if (!isAdminPath(pathname)) return 'not-staff';
  if (adminIndex(pathname)) return 'admin-index';
  if (selfReloadBarred(pathname, from)) return isWavesAdminApp() ? 'waves-admin' : 'field-page';
  const build = newerBuild();
  if (!build) return heardFromServerWithin(Infinity, now) ? 'current' : 'never-heard';
  if (browserOffline()) return 'offline';
  if (!hasSignal(now)) return 'no-signal';
  const tries = reloadTries(build);
  if (tries === null) return 'storage';
  if (tries >= RELOAD_TRIES) return 'reloaded';
  return reloadHoldName() ?? (stalledWork() ? 'stalled' : null);
}

// The note for the page this tab loaded: 'first-page', or 'reload-missed'
// when this page load is the reload this module made for a newer build and
// the page came back on the build it left (reloadForNewBuild marks that build
// as `from`): the service worker answered with its saved copy. A reload that
// lands on any other build updated the tab, also when a later build went live
// meanwhile. The first read takes the mark, so a later load of the tab reads
// 'first-page' again.
let loadNote;
export function pageLoadNote() {
  if (loadNote !== undefined) return loadNote;
  loadNote = 'first-page';
  try {
    const marker = JSON.parse(sessionStorage.getItem(RELOADED_FOR));
    if (marker?.from) {
      if (marker.from === loadedBuild()) loadNote = 'reload-missed';
      sessionStorage.setItem(RELOADED_FOR, JSON.stringify({ build: marker.build, tries: marker.tries }));
    }
  } catch { /* storage cannot be read: the tab made no reload */ }
  return loadNote;
}

export function resetPageLoadNoteForTests() {
  loadNote = undefined;
}

// What the latest page move did, for the usage beacon (lib/adminUsage.js):
// the blocker that kept the page in view in this build, null when its move
// was due a reload, or the page-load note for the page the tab loaded.
// PortalUpdateGate notes it once each move is in view, and when a held
// reload gives up.
let moveOutcome = { pathname: null, blocker: null };
export function noteMoveOutcome(pathname, blocker) {
  moveOutcome = { pathname, blocker };
}

// The note when the latest move opened `pathname`, as the router reads it,
// else null. Trailing slashes do not count, as for the router: it opens
// /admin/settings/ as Settings, and Settings reports /admin/settings.
export function moveBlockerFor(pathname) {
  const page = (path) => routerPath(path).replace(/\/+$/, '');
  return moveOutcome.pathname !== null && page(moveOutcome.pathname) === page(pathname)
    ? moveOutcome.blocker
    : null;
}

// Saves still open: API writes on their way, and writes to the device's own
// storage, such as the draft a closing page saves (deviceWrites.js).
const savesInFlight = () => writesInFlight() + deviceWritesInFlight();

// Work a reload would cut off: every API request still on its way, reads
// included, since a read can be the first step of a send (portalVersion.js),
// and every write to the device's storage. The automatic reload waits for it.
const workInFlight = () => requestsInFlight() + deviceWritesInFlight();

// What a reload would cut off right now: 'saving' for a save still open, and
// 'request' for a read still open (a read can be the first step of a send).
// Both are named when both are open, so "Reload anyway" past a named save
// never cuts off a read that started since. A body read counts as a read.
function workBlockers() {
  const reads = requestsInFlight() - writesInFlight();
  return [...(savesInFlight() > 0 ? ['saving'] : []), ...(reads > 0 ? ['request'] : [])];
}

// What stops a reload besides open work: each registered hold's name, then
// 'offline' when the browser reports itself offline (a reload then opens an
// error page). A wait for open work ends none of them, so neither a page move
// nor a page whose code is missing (staleChunkReload.js) waits while one
// stands.
export function blockersBesideWork() {
  return [...reloadHoldNames(), ...(browserOffline() ? ['offline'] : [])];
}

// Everything that stops a reload right now: the work above, then the rest
// (blockersBesideWork). The automatic reload and the Reload bar both read it;
// the bar names each item before it reloads.
export function reloadBlockers() {
  return [...workBlockers(), ...blockersBesideWork()];
}

// The first of them, or null.
export function reloadBlocker() {
  return reloadBlockers()[0] ?? null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Work that outlasted a full wait, such as a device write that never settles,
// would make every later move wait 10 s again. So until all work settles, a
// move opens its page at once and the bar stays, and a page whose code is
// missing does not wait for it again (waitForWork); after that, moves are due
// as before.
let workStalled = false;

function stalledWork() {
  if (workStalled && workInFlight() === 0) workStalled = false;
  return workStalled;
}

async function waitOutStalledWork() {
  workStalled = true;
  while (workInFlight() > 0) await pause(200);
  workStalled = false;
}

// Waits up to 10 s for open requests and device writes to settle (a closing
// page can start one). Stalled work is not waited for again, so one hung
// request costs one wait, whether the reload at a page move or a page whose
// code is missing (staleChunkReload.js) waits first. `done()` ends the wait
// at its next look, once no reload can follow it. The work has then not
// outlasted a full wait, so it does not count as stalled.
export async function waitForWork({ now = () => Date.now(), done = () => false } = {}) {
  if (stalledWork()) return;
  const until = now() + WRITE_WAIT_MS;
  while (workInFlight() > 0 && now() < until) {
    if (done()) return;
    await pause(200);
  }
  if (workInFlight() > 0 && !workStalled) void waitOutStalledWork();
}

// Waits for open work (waitForWork), then reloads once for the live build.
// Resolves the blocker's name when it does not reload; `current()` turns
// false when the user moved on meanwhile.
export async function reloadForNewBuild({
  current = () => true,
  reload = () => window.location.reload(),
  now = () => Date.now(),
} = {}) {
  // With no work open there is no wait, and the reload runs in this turn.
  if (workInFlight() > 0) await waitForWork({ now });
  const blocker = current() ? reloadBlocker() : 'moved';
  if (blocker) return blocker;
  const build = newerBuild();
  if (!build) return 'current';
  const tries = reloadTries(build);
  if (tries === null) return 'storage';
  if (tries >= RELOAD_TRIES) return 'reloaded';
  // The wait for writes can outlast the signal: ask again.
  if (!hasSignal(now())) return 'no-signal';
  try { sessionStorage.setItem(RELOADED_FOR, JSON.stringify({ build, tries: tries + 1, from: loadedBuild() })); } catch { return 'storage'; }
  reload();
  return null;
}
