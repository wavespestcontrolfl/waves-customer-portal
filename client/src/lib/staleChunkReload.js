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
// A reload closes the page in view and opens the address. While a move is
// not yet in view the two differ: the address changes first, and Back
// changes it even before the routes render. So every rule here judges both
// pages. The staff rules apply while either is a staff page (staffTab), and
// a page that never reloads by itself bars the reload whether it is in view
// or at the address. A page whose code is missing reloads only while the
// address names its route: after Back, its reload would open the next page.
//
// A part opens in place, so the page around it can hold unsaved work in
// component state that no hold names. So a staff tab used on the page in
// view since it came into view (watchPageUse) keeps the tab too: a part asks
// before it reloads, and any other import() fails to its caller. A use
// counts for the page in view, not for the address, which names the next
// page while a move is not yet in view. A page move ends that use once it is
// in view (notePageInView), so a page whose code is missing still reloads at
// once when nothing holds the tab.
//
// Waves Admin and the field pages never reload by themselves, as at a page
// move (selfReloadBarred, lib/portalReload.js): a reload with no signal opens
// an offline screen. Nor does the page a move from a field page opens, as
// PortalUpdateGate judges that move (notePageMove): field work can still be
// on its way. There a missing chunk always leaves the import to fail, so the
// page or the part asks.
//
// The one reload for a missing chunk counts until the tab leaves the path it
// reopened (chunkReloadAttempted): a route can load in parts, and the part
// that loads clears the one-shot flag before the part still missing fails.

import { isAdminPath, routerPath } from './adminBookmarkMeta';
import {
  blockersBesideWork, isPageUse, PAGE_USE_EVENTS, reloadBlocker, selfReloadBarred, waitForWork,
} from './portalReload';

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

const NO_MOVE = { from: null, to: null };

let reloadPending = false;
let navigatingUntil = 0;
let chunkHeld = false;
let usedPath = null;
let renderedMove = NO_MOVE;
let shownMove = NO_MOVE;
let reloadedPath = pathOpenedByChunkReload();

// PortalUpdateGate (components/PortalUpdate.jsx) notes each page move: `to`
// the page it opens, `from` the page it leaves as #8121's rule judges it (a
// redirect continues the move it ends, so Today -> /admin -> the dashboard
// still leaves Today). It notes the move as it renders, before the new
// page's code starts to load, and again once the move is in view. React can
// drop a render: Back can undo a move while the new page's code loads. So a
// rendered move counts only on the page it opens; elsewhere the move in view
// does.
export function notePageMove(from, to) {
  renderedMove = { from, to };
}

// A move in view also ends the use of the page it left, as for the Reload
// bar (usePageUsed): the move remounted the routes, so nothing unsaved stays
// from that use, and Back to that page opens it unused. A move React dropped
// leaves the page and its use. A move in view to another page also ends the
// count of the one reload on the path it reopened (chunkReloadAttempted):
// React.lazy keeps a page it loaded, so Back to that path loads nothing that
// would end it (noteChunkLoaded).
export function notePageInView(from, to) {
  shownMove = { from, to };
  usedPath = null;
  if (reloadedPath !== null && routerPath(to) !== routerPath(reloadedPath)) reloadedPath = null;
}

// The page that the move to `pathname` left. Null for a move the gate has not
// rendered yet: the page in view then judges it (staffSelfReloadBarred).
function moveFromFor(pathname) {
  if (renderedMove.to === pathname) return renderedMove.from;
  return shownMove.to === pathname ? shownMove.from : null;
}

// The page in view: the one the last move in view opened, or before any
// move, the address. While a move is not yet in view, the address already
// names the next page, and Back can still undo that move.
function pageInView() {
  return shownMove.to ?? window.location.pathname;
}

// Whether the staff rules apply: while the page in view or the address is a
// staff page (see the top of this file). App.jsx and LazyPanel.jsx ask it
// too, for a page or a part whose code is missing.
export function staffTab() {
  return isAdminPath(pageInView()) || isAdminPath(window.location.pathname);
}

// What holds a staff tab (lib/portalReload.js), or null. Customer pages are
// unchanged.
function staffBlocker() {
  return staffTab() ? reloadBlocker() : null;
}

// Notes each use of a page against the page in view, as the Reload bar
// counts a use (isPageUse, lib/portalReload.js). Installed once, by main.jsx.
export function watchPageUse(target = document) {
  const noteUse = (event) => { if (isPageUse(event)) usedPath = pageInView(); };
  PAGE_USE_EVENTS.forEach((type) => target.addEventListener(type, noteUse, true));
  return () => PAGE_USE_EVENTS.forEach((type) => target.removeEventListener(type, noteUse, true));
}

// Whether the tab was used on the staff page in view since it came into
// view.
export function usedOnThisStaffPage() {
  const pathname = pageInView();
  return isAdminPath(pathname) && usedPath === pathname;
}

// A staff tab that never reloads by itself (see the top of this file): the
// page in view or the address bars it, each judged by the move that opened
// it.
function staffSelfReloadBarred() {
  return staffTab() && [pageInView(), window.location.pathname]
    .some((pathname) => selfReloadBarred(pathname, moveFromFor(pathname)));
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
// loads clears the flag (noteChunkLoaded), and a route can load in parts: a
// page, then a part that opens with it, such as a panel its URL names. So the
// path that reload reopened counts too, or a part still missing under a page
// that loaded would reload the tab at every load. That path counts until the
// tab leaves it: a page loads on another path, or a move to another page
// comes into view (notePageInView). Throws when storage is blocked.
function chunkReloadAttempted() {
  return window.location.pathname === reloadedPath || Boolean(sessionStorage.getItem(CHUNK_RELOAD_FLAG));
}

// Takes the one reload for a missing chunk: sets the flag and returns true.
// Returns false when this tab already took it, or when session storage is
// blocked: with no one-shot guard, the tab never reloads by itself.
export function takeChunkReload() {
  try {
    if (chunkReloadAttempted()) return false;
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    return true;
  } catch {
    return false;
  }
}

// A page loaded (App.jsx lazyWithRetry): the live build serves its code, so a
// later deploy may reload the tab again. The path the one reload reopened
// counts until the tab leaves it (chunkReloadAttempted). Best effort:
// blocked storage must not fail a page whose code loaded. While a reload for
// a missing chunk is under way, a load does not count: the flag must reach
// the page load that reload opens. Vite still imports a page whose
// stylesheet is missing, and that script can load before the reload lands.
export function noteChunkLoaded() {
  if (reloadPending) return;
  if (window.location.pathname !== reloadedPath) reloadedPath = null;
  try { sessionStorage.removeItem(CHUNK_RELOAD_FLAG); } catch { /* storage blocked */ }
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

// One-shot guard (takeChunkReload) so a genuine outage still surfaces instead
// of reload-looping.
export function handleVitePreloadError(event, reload = () => window.location.reload()) {
  if (pageNavigating()) {
    chunkHeld = true;
    event.preventDefault();
    return;
  }
  // A staff tab with open or held work, used on the page in view since the
  // last page move, or on a page that never reloads by itself: the import
  // fails as it would with no handler (see the top of this file).
  if (staffBlocker() || usedOnThisStaffPage() || staffSelfReloadBarred()) return;
  if (!takeChunkReload()) return;
  markStaleChunkReloadPending();
  event.preventDefault();
  reload();
}

// Why a staff page whose code is missing cannot reload by itself, whatever
// open work does: 'reloaded' when this tab already reloaded once for a
// missing chunk (a real outage then gets the retry screen, not a reload
// loop), 'storage' when session storage is blocked (no one-shot guard),
// 'page-use' when the tab was used on this page (its retry screen asks
// first, as the preload error would), 'manual' on a page that never reloads
// by itself, or what else holds the tab: a registered hold's name, or
// 'offline' while the browser reports itself offline (blockersBesideWork in
// lib/portalReload.js). The wait for open work ends none of them, so the page
// does not wait while one stands, as a page move does not, and its wait ends
// once one comes up. Null when it can.
function selfReloadRuledOut() {
  try {
    if (chunkReloadAttempted()) return 'reloaded';
  } catch {
    return 'storage';
  }
  if (usedOnThisStaffPage()) return 'page-use';
  if (staffSelfReloadBarred()) return 'manual';
  return blockersBesideWork()[0] ?? null;
}

// Whether a screen for missing staff code (App.jsx, components/LazyPanel.jsx)
// says the portal has a new version: only when the server names a newer
// build (`newer`, lib/portalVersion.js), as for the Reload bar, the device is
// online (`offline`: false), and the one reload for a missing chunk has not
// run here. A chunk can also fail from an asset fault or an outage; then the
// screen asks to check the connection. The screens pass both from
// subscriptions (useNewerBuild, useBrowserOffline in PortalUpdate.jsx), so
// the text changes while it shows.
export function missingCodeIsNewVersion(newer, offline) {
  if (!newer || offline) return false;
  try {
    return !chunkReloadAttempted();
  } catch {
    return true; // storage blocked: no reload ran
  }
}

// A staff page whose code is missing (App.jsx): waits for open work, as a
// page move does, then reloads once, as for a stale chunk, when nothing holds
// the tab. It waits only while a reload can follow: otherwise its screen
// comes at once, and the wait ends at its next look once none can (the page
// closed or moved, or a reason of selfReloadRuledOut came up). `pathname`:
// the path of the route whose code is missing, as the router rendered it
// (App.jsx). It reloads only while the address names that route, as the
// routes match a path, before and after the wait. Back moves the address on
// at once, even before this page's effect starts, but the routes keep this
// page in view until the next page's code loads: a reload then would open
// the next page and spend the one reload on it. With no `pathname`, it never
// reloads. Resolves why it did not reload: 'moved' when the address names
// another page, or the page closed during the wait; then 'reloaded',
// whatever holds the tab (after the one reload a missing page is an outage,
// so its screen offers the connection retry); then what holds the tab; then
// the other reasons of selfReloadRuledOut. The screen for 'moved' shows
// until the next page comes into view.
export async function reloadForMissingCode({
  pathname,
  current = () => true,
  reload = () => window.location.reload(),
  now,
} = {}) {
  const atPage = () => routerPath(window.location.pathname) === routerPath(pathname);
  if (!atPage()) return 'moved';
  const noReload = () => !current() || !atPage() || Boolean(selfReloadRuledOut());
  if (!noReload()) await waitForWork({ now, done: noReload });
  if (!current() || !atPage()) return 'moved';
  // From here to the reload, all in one turn: no work can start and no hold
  // can register between the last look and the reload. The wait can also
  // outlast a use of the page or another reload.
  const reason = selfReloadRuledOut();
  if (reason === 'reloaded') return reason;
  const blocker = staffBlocker();
  if (blocker) return blocker;
  if (reason) return reason;
  try {
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
  renderedMove = NO_MOVE;
  shownMove = NO_MOVE;
  reloadedPath = pathOpenedByChunkReload();
}
