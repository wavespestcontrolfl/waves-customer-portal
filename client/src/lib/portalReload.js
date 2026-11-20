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
import { isAdminPath, isFieldPath } from './adminBookmarkMeta';
import { deviceWritesInFlight } from './deviceWrites';
import { heardFromServerWithin, newerBuild, requestsInFlight, writesInFlight } from './portalVersion';
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
// yet. Without session storage the tab cannot count its tries, so it never
// reloads by itself.
function reloadTries(build) {
  try {
    const marker = JSON.parse(sessionStorage.getItem(RELOADED_FOR));
    if (marker?.build !== build) return 0;
    return Number.isInteger(marker.tries) ? marker.tries : RELOAD_TRIES;
  } catch { return RELOAD_TRIES; }
}

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

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
const adminIndex = (pathname) => /^\/admin\/?$/i.test(String(pathname ?? ''));

// `from`: the page the move leaves.
export function reloadDueAtMove(pathname, now = Date.now(), from = null) {
  const build = newerBuild();
  return Boolean(build)
    && isAdminPath(pathname) && !adminIndex(pathname)
    && !isFieldPath(pathname) && !isFieldPath(from) && !isWavesAdminApp()
    && hasSignal(now)
    && reloadTries(build) < RELOAD_TRIES
    && !reloadHoldName()
    && !stalledWork();
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

// Everything that stops a reload right now: the work above, then each
// registered hold's name, then 'offline' when the browser reports itself
// offline (a reload then opens an error page). The automatic reload and the
// Reload bar both read it; the bar names each item before it reloads.
export function reloadBlockers() {
  return [
    ...workBlockers(),
    ...reloadHoldNames(),
    ...(browserOffline() ? ['offline'] : []),
  ];
}

// The first of them, or null.
export function reloadBlocker() {
  return reloadBlockers()[0] ?? null;
}

// The stale-chunk reload asks too (staleChunkReload.js): on a staff page,
// anything above keeps the tab. Customer pages are unchanged.
export function staffReloadBlocker(pathname = window.location.pathname) {
  return isAdminPath(pathname) ? reloadBlocker() : null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Work that outlasted a full wait, such as a device write that never settles,
// would make every later move wait 10 s again. So until all work settles, a
// move opens its page at once and the bar stays; after that, moves are due as
// before.
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
// page can start one), then reloads once for the live build. Resolves the
// blocker's name when it does not reload; `current()` turns false when the
// user moved on meanwhile.
export async function reloadForNewBuild({
  current = () => true,
  reload = () => window.location.reload(),
  now = () => Date.now(),
} = {}) {
  const until = now() + WRITE_WAIT_MS;
  while (workInFlight() > 0 && now() < until) await pause(200);
  if (workInFlight() > 0 && !workStalled) void waitOutStalledWork();
  const blocker = current() ? reloadBlocker() : 'moved';
  if (blocker) return blocker;
  const build = newerBuild();
  if (!build) return 'current';
  const tries = reloadTries(build);
  if (tries >= RELOAD_TRIES) return 'reloaded';
  // The wait for writes can outlast the signal: ask again.
  if (!hasSignal(now())) return 'no-signal';
  try { sessionStorage.setItem(RELOADED_FOR, JSON.stringify({ build, tries: tries + 1 })); } catch { return 'storage'; }
  reload();
  return null;
}

// Waits up to 10 s for open requests and device writes to settle, as a page
// move does, then names what still holds a staff tab, or null.
export async function staffBlockerAfterWork({ now = () => Date.now() } = {}) {
  const until = now() + WRITE_WAIT_MS;
  while (workInFlight() > 0 && now() < until) await pause(200);
  return staffReloadBlocker();
}
