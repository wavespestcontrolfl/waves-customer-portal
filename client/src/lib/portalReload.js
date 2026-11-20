// An out-of-date staff tab reloads once, at its next page move, so the page
// the user opens runs the live code (owner 2026-11-19, option A). App.jsx's
// PortalUpdateGate shows the loading placeholder while this runs, after the
// old page has closed: the move already dropped that page's state, so the
// reload loses nothing more. Work that outlives a move holds it
// (reloadHolds.js), and so does an API write still on its way after 10 s.
// Waves Admin never reloads by itself (a reload with no signal opens the
// app's offline screen), nor do the field pages (/admin/today must work with
// no signal); both, like every staff page, get the Reload bar. No tab reloads
// by itself while the browser reports it is offline.
import { isAdminPath, isFieldPath } from './adminBookmarkMeta';
import { heardFromServerWithin, newerBuild, writesInFlight } from './portalVersion';
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

// A reload with no connection swaps a working page for an offline error.
function offline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function reloadDueAtMove(pathname, now = Date.now()) {
  const build = newerBuild();
  return Boolean(build)
    && isAdminPath(pathname) && !isFieldPath(pathname) && !isWavesAdminApp()
    && !offline() && heardFromServerWithin(RECENT_ANSWER_MS, now)
    && !reloadedFor(build)
    && !reloadHoldName();
}

// Everything that stops a reload right now: 'saving' for an API write on its
// way, then each registered hold's name.
export function reloadBlockers() {
  return [...(writesInFlight() > 0 ? ['saving'] : []), ...reloadHoldNames()];
}

// The first of them, or null.
export function reloadBlocker() {
  return reloadBlockers()[0] ?? null;
}

// The stale-chunk reload (staleChunkReload.js, App.jsx's lazyWithRetry) asks
// too: on a staff page, held work keeps the tab, and a page whose code the
// deploy removed shows its retry screen instead. Customer pages are unchanged.
export function staffReloadBlocker(pathname = window.location.pathname) {
  return isAdminPath(pathname) ? reloadBlocker() : null;
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Waits up to 10 s for API writes to land (a closing page can start one),
// then reloads once for the live build. Resolves the blocker's name when it
// does not reload; `current()` turns false when the user moved on meanwhile.
export async function reloadForNewBuild({
  current = () => true,
  reload = () => window.location.reload(),
  now = () => Date.now(),
} = {}) {
  const until = now() + WRITE_WAIT_MS;
  while (writesInFlight() > 0 && now() < until) await pause(200);
  const blocker = current() ? reloadBlocker() : 'moved';
  if (blocker) return blocker;
  const build = newerBuild();
  if (!build) return 'current';
  if (reloadedFor(build)) return 'reloaded';
  if (offline()) return 'offline';
  try { sessionStorage.setItem(RELOADED_FOR, build); } catch { return 'storage'; }
  reload();
  return null;
}
