// Stale-chunk reload state, shared by main.jsx (vite:preloadError), App.jsx
// (lazyWithRetry) and the page error boundary.
//
// A tab that lives across a deploy asks for hashed chunks the new build no
// longer serves. Vite 5.4 routes that failure — CSS preload OR the chunk's own
// import() — through vite:preloadError, and when the handler calls
// preventDefault() the dynamic import RESOLVES TO undefined instead of
// rejecting. React.lazy then reads undefined.default and throws a TypeError
// into the nearest boundary, so every stale click flashed the full-screen
// "Something went wrong" until the reload landed (owner 2026-10-25). The
// boundary and lazyWithRetry read isStaleChunkReloadPending() to show the
// loading placeholder for that window instead.
//
// A navigation the app shell starts (an app link or a push tap) opens a window
// too. WebKit cancels every chunk load still in flight when a navigation
// starts, and each cancelled import reaches vite:preloadError like a stale
// chunk. Reloading then replaced the navigation with the page being left: on
// 2026-10-31 every iPhone app link landed on Home, because the link navigates
// at launch while the home page chunks are still loading. In the window the
// handler holds such a chunk instead. Once one is held, the boundary and
// lazyWithRetry hold later failures too; if this page is still here when the
// window ends, the navigation never committed and the page reloads.
//
// On a staff page, the reload obeys the holds of an out-of-date tab
// (lib/portalReload.js): open requests and device writes, held work, and a
// browser offline. While any of them holds the tab, the handler leaves the
// import to fail. A page whose code is missing then waits for open work, as
// a page move does, and reloads once or shows its retry screen
// (reloadForMissingCode, App.jsx). A part of a page shows a Reload prompt in
// its place (components/LazyPanel.jsx).
//
// A part opens in place, so the page around it can hold unsaved work in
// component state that no hold names. So a staff tab whose last use was on
// its current path (watchPageUse) keeps the tab too: a part asks before it
// reloads, and any other import() fails to its caller. A page move opens a
// new path, so a page whose code is missing still reloads at once when
// nothing holds the tab.
//
// The one reload for a missing chunk counts until the tab leaves the path it
// reopened (chunkReloadAttempted): a route can load in parts, and the part
// that loads clears the one-shot flag before the part still missing fails.

import { isAdminPath } from './adminBookmarkMeta';
import { isPageUse, PAGE_USE_EVENTS, staffBlockerAfterWork, staffReloadBlocker } from './portalReload';

export const CHUNK_RELOAD_FLAG = 'chunk-reload-attempted';

// The error for a chunk the live build no longer serves: the browser's own
// for a module script (Chrome, Safari, Firefox), webpack's name, and Vite's
// for a page stylesheet gone the same way.
export function isChunkError(err) {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Unable to preload CSS/i
    .test(String(err?.message || ''));
}

// Long enough for a slow navigation to commit. It bounds how long a page whose
// navigation never committed keeps placeholders before it reloads.
const NAVIGATION_WINDOW_MS = 30000;

let reloadPending = false;
let navigatingUntil = 0;
let chunkHeld = false;
let usedPath = null;
let reloadedPath = pathOpenedByChunkReload();

// Notes the path of each use of a page, as the Reload bar counts a use
// (isPageUse, lib/portalReload.js). Installed once, by main.jsx.
export function watchPageUse(target = document) {
  const noteUse = (event) => { if (isPageUse(event)) usedPath = window.location.pathname; };
  PAGE_USE_EVENTS.forEach((type) => target.addEventListener(type, noteUse, true));
  return () => PAGE_USE_EVENTS.forEach((type) => target.removeEventListener(type, noteUse, true));
}

// Whether the tab's last use was on the staff page in view.
export function usedOnThisStaffPage() {
  const { pathname } = window.location;
  return isAdminPath(pathname) && usedPath === pathname;
}

// The path this page load opened on, when the one reload for a missing chunk
// opened it: the flag is set only right before that reload.
function pathOpenedByChunkReload() {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_FLAG) ? window.location.pathname : null;
  } catch {
    return null;
  }
}

// Whether this tab already reloaded once for a missing chunk. A page that
// loads clears the flag (noteChunkLoaded), and a route can load in parts: on
// /admin/today/protocols the Today shell loads, then its page. So the path
// that reload reopened counts too, or a page still missing under a shell that
// loaded would reload the tab at every load. Throws when storage is blocked.
export function chunkReloadAttempted() {
  return window.location.pathname === reloadedPath || Boolean(sessionStorage.getItem(CHUNK_RELOAD_FLAG));
}

// A page loaded (App.jsx lazyWithRetry): the live build serves its code, so a
// later deploy may reload the tab again. The path the one reload reopened
// counts until a page loads on another path.
export function noteChunkLoaded() {
  if (window.location.pathname !== reloadedPath) reloadedPath = null;
  sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
}

function pageNavigating() {
  return Date.now() < navigatingUntil;
}

// Only a window that holds a chunk hides failures: that window always ends in
// a commit or a reload, never in a page left on its placeholder.
export function isStaleChunkReloadPending() {
  return reloadPending || (chunkHeld && pageNavigating());
}

export function markStaleChunkReloadPending() {
  reloadPending = true;
}

// Call right before location.assign. Returns the call that closes the window
// when the navigation did not start.
export function markPageNavigating(reload = () => window.location.reload()) {
  const until = Date.now() + NAVIGATION_WINDOW_MS;
  navigatingUntil = until;
  // The page is still here: the navigation never committed, and React.lazy
  // keeps the placeholder each held chunk resolved to. Reload, as for a stale
  // chunk. No one-shot guard: this runs at most once per navigation, and the
  // next document skips the launch URL it already consumed.
  const reloadHeldChunks = () => {
    navigatingUntil = 0;
    if (!chunkHeld) return;
    chunkHeld = false;
    markStaleChunkReloadPending();
    reload();
  };
  const timer = setTimeout(() => {
    if (navigatingUntil === until) reloadHeldChunks();
  }, NAVIGATION_WINDOW_MS);
  return () => {
    if (navigatingUntil !== until) return;
    clearTimeout(timer);
    reloadHeldChunks();
  };
}

// One-shot guard (chunkReloadAttempted) so a genuine outage still surfaces
// instead of reload-looping.
export function handleVitePreloadError(event, reload = () => window.location.reload()) {
  if (pageNavigating()) {
    chunkHeld = true;
    event.preventDefault();
    return;
  }
  // A staff tab with open or held work, or last used on this path: the
  // import fails as it would with no handler (see the top of this file).
  if (staffReloadBlocker() || usedOnThisStaffPage()) return;
  try {
    if (chunkReloadAttempted()) return;
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  } catch {
    return;
  }
  markStaleChunkReloadPending();
  event.preventDefault();
  reload();
}

// A staff page whose code is missing (App.jsx): waits for open work, as a
// page move does, then reloads once, as for a stale chunk, when nothing holds
// the tab. Resolves why it did not reload: what holds the tab, 'reloaded'
// when this tab already reloaded once for a missing chunk (a real outage then
// gets the retry screen, not a reload loop), 'page-use' when the tab was used
// on this page meanwhile (its retry screen asks first, as the preload error
// would), 'storage' when session storage is blocked (no one-shot guard), or
// 'moved' when the page closed meanwhile.
export async function reloadForMissingCode({
  current = () => true,
  reload = () => window.location.reload(),
  now,
} = {}) {
  const blocker = await staffBlockerAfterWork({ now });
  if (!current()) return 'moved';
  if (blocker) return blocker;
  try {
    if (chunkReloadAttempted()) return 'reloaded';
    if (usedOnThisStaffPage()) return 'page-use';
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  } catch {
    return 'storage';
  }
  markStaleChunkReloadPending();
  reload();
  return null;
}

// Test-only: a new page load. Module state otherwise lives for the page's
// lifetime.
export function resetStaleChunkReloadForTests() {
  reloadPending = false;
  navigatingUntil = 0;
  chunkHeld = false;
  usedPath = null;
  reloadedPath = pathOpenedByChunkReload();
}
