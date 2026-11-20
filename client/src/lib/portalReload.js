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

// One automatic reload per live build. Without session storage the tab could
// not tell that it already reloaded, so it never reloads by itself.
function reloadedFor(build) {
  try { return sessionStorage.getItem(RELOADED_FOR) === build; } catch { return true; }
}

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// A reload with no connection swaps a working page for an offline error, so
// it needs a recent answer from the new server, and the browser must not
// report itself offline.
function hasSignal(now) {
  return !browserOffline() && heardFromServerWithin(RECENT_ANSWER_MS, now);
}

// `from`: the page the move leaves.
export function reloadDueAtMove(pathname, now = Date.now(), from = null) {
  const build = newerBuild();
  return Boolean(build)
    && isAdminPath(pathname) && !isFieldPath(pathname) && !isFieldPath(from) && !isWavesAdminApp()
    && hasSignal(now)
    && !reloadedFor(build)
    && !reloadHoldName();
}

// Saves still open: API writes on their way, and writes to the device's own
// storage, such as the draft a closing page saves (deviceWrites.js).
const savesInFlight = () => writesInFlight() + deviceWritesInFlight();

// Work a reload would cut off: every API request still on its way, reads
// included, since a read can be the first step of a send (portalVersion.js),
// and every write to the device's storage. The automatic reload waits for it.
const workInFlight = () => requestsInFlight() + deviceWritesInFlight();

// Everything that stops a reload right now: 'saving' for a save still open,
// then each registered hold's name, then 'offline' when the browser reports
// itself offline (a reload then opens an error page). Every reload button
// names them before it reloads.
export function reloadBlockers() {
  return [
    ...(savesInFlight() > 0 ? ['saving'] : []),
    ...reloadHoldNames(),
    ...(browserOffline() ? ['offline'] : []),
  ];
}

// The first of them, or null.
export function reloadBlocker() {
  return reloadBlockers()[0] ?? null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Waits up to 10 s for open requests and device writes to settle (a closing
// page can start one), then reloads once for the live build. Resolves the blocker's name when it
// does not reload; `current()` turns false when the user moved on meanwhile.
export async function reloadForNewBuild({
  current = () => true,
  reload = () => window.location.reload(),
  now = () => Date.now(),
} = {}) {
  const until = now() + WRITE_WAIT_MS;
  while (workInFlight() > 0 && now() < until) await pause(200);
  const blocker = current() ? (workInFlight() > 0 ? 'saving' : reloadBlocker()) : 'moved';
  if (blocker) return blocker;
  const build = newerBuild();
  if (!build) return 'current';
  if (reloadedFor(build)) return 'reloaded';
  // The wait for writes can outlast the signal: ask again.
  if (!hasSignal(now())) return 'no-signal';
  try { sessionStorage.setItem(RELOADED_FOR, build); } catch { return 'storage'; }
  reload();
  return null;
}
