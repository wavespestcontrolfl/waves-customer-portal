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
// On a staff page, the handler never reloads: it leaves the import to fail,
// and the page or part that asked for the code decides, while it is still
// mounted. The handler cannot tell which import failed. After Back, the
// import of a page whose move React dropped can fail while the page Back
// returned to is in view, and a reload would spend the one reload there. A
// page whose code is missing obeys the holds of an out-of-date tab
// (lib/portalReload.js): open requests and device writes, held work, and a
// browser offline. It waits for open work, as a page move does, and reloads
// once or shows its retry screen (reloadForMissingCode, App.jsx). A part of
// a page shows a Reload prompt in its place (components/LazyPanel.jsx), and
// any other import() fails to its caller. Back can also open a customer page
// while code a staff tab asked for is on its way. So while any is
// (trackStaffImport), the handler leaves every import to fail, and each
// consumer decides by the tab it was asked on: a staff page or part that
// is no longer mounted then reloads nothing, and a customer page whose own
// code fails reloads at once through its loader, as the handler would. A
// page asked for on a staff tab keeps the staff rules through its recovery
// (reloadForMissingCode), also once the move that asked for it, such as
// Back, opened a customer page: a move from a field page still bars its
// reload, and open work still holds it.
//
// A reload closes the page in view and opens the address. While a move is
// not yet in view the two differ: the address changes first, and Back
// changes it even before the routes render. So every rule here judges both
// pages. The staff rules apply while either is a staff page, or a page that a
// move from a field page opened (staffTab), and a page that never reloads by
// itself bars the reload whether it is in view or at the address. A redirect
// continues the move it ends, so until the move's last page is in view, the
// page the move started on counts too (moveUnderWayFrom). A page whose code
// is missing reloads only while the address names that page: after Back, its
// reload would open the next page. Two paths name one page when they decode
// alike, case kept (samePage).
//
// A page can hold unsaved work in component state that no hold names. So a
// staff tab used on the page in view since it came into view (watchPageUse)
// keeps the tab too: a page whose code is missing shows its retry screen,
// which asks first. A use counts for the page in view, not for the address,
// which names the next page while a move is not yet in view. A page move
// ends that use once it is in view (notePageInView), so a page whose code is
// missing still reloads at once when nothing holds the tab.
//
// Waves Admin and the field pages never reload by themselves, as at a page
// move (selfReloadBarred, lib/portalReload.js): a reload with no signal opens
// an offline screen. Nor does the page a move from a field page opens, as
// PortalUpdateGate judges that move (notePageMove): field work can still be
// on its way. There a page whose code is missing shows its retry screen.
// That page keeps the staff rules, a customer page too, and a redirect
// continues the move: Back from Today to /recap/:token, which redirects to
// /report/:token, opens the report from Today. In Waves Admin every page
// keeps the staff rules, as the app can open a report link in its own
// webview.
//
// The one reload for a missing chunk counts until the tab leaves the path it
// reopened (chunkReloadAttempted): a route can load in parts, and the part
// that loads clears the one-shot flag before the part still missing fails.
//
// Vite's preload helper marks a stylesheet as loaded once it starts to load
// it. So a tab that lives on after a stylesheet failed, as a held staff tab
// does, would skip it at a later import that lists it, and render that page
// without it, with no error. The build changes the helper
// (lib/stylesheetRetry.js): an import that lists a stylesheet still loading
// waits for it and fails with it, and a stylesheet that failed is forgotten,
// so the next import that lists it loads it again, and fails as the first
// did while it is still missing.

import { decodedPath, isAdminPath, isFieldPath } from './adminBookmarkMeta';
import { isWavesAdminApp } from '../native/platform';
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

const NO_MOVE = { from: null, to: null, origin: null };

let reloadPending = false;
let navigatingUntil = 0;
let chunkHeld = false;
let usedPath = null;
let renderedMove = NO_MOVE;
let shownMove = NO_MOVE;
let reloadedPath = pathOpenedByChunkReload();
const staffImports = new Set();

// Whether two paths name one page: alike once each is decoded, case kept
// (decodedPath, lib/adminBookmarkMeta.js). The router keeps a link's path as
// written, while the browser encodes the address, and one page's address can
// be spelled two ways, such as /%61dmin/dashboard and /admin/dashboard. A
// route's parameters keep their case. Every rule here that compares a path
// from one source with a path from another asks this.
function samePage(a, b) {
  return a != null && b != null && decodedPath(a) === decodedPath(b);
}

// PortalUpdateGate (components/PortalUpdate.jsx) notes each page move: `to`
// the page it opens, `from` the page it leaves as #8121's rule judges it (a
// redirect continues the move it ends, so Today -> /admin -> the dashboard
// still leaves Today), and `origin` the page the move started on, before any
// redirect. It notes the move as it renders, before the new page's code
// starts to load, and again once the move is in view. React can drop a
// render: Back can undo a move while the new page's code loads. So a rendered
// move counts only on the page it opens; elsewhere the move in view does.
export function notePageMove(from, to, origin = from) {
  renderedMove = { from, to, origin };
}

// A move in view also ends the use of the page it left (usedOnPageInView):
// the move remounted the routes, so nothing unsaved stays from that use, and
// Back to that page opens it unused. A move React dropped leaves the page and
// its use. A move in view away from the path the one reload reopened, to
// another page (samePage), also ends that reload's count, path and flag
// (chunkReloadAttempted); nothing else does. A move can load nothing:
// React.lazy keeps a page it loaded, the More page is in the entry bundle,
// and the reopened page may still fail. While a reload is under way, the flag
// must reach the page load it opens. During an outage a page the tab then
// opens can take one more reload; after it, that page shows its retry screen.
export function notePageInView(from, to) {
  shownMove = { from, to };
  usedPath = null;
  if (reloadPending || reloadedPath === null || samePage(to, reloadedPath)) return;
  reloadedPath = null;
  clearChunkReloadFlag();
}

// The page that the move to `pathname` left. Null for a move the gate has not
// rendered yet: the page in view then judges it (staffSelfReloadBarred).
// `pathname` can be the address, in the browser's spelling.
function moveFromFor(pathname) {
  if (samePage(renderedMove.to, pathname)) return renderedMove.from;
  return samePage(shownMove.to, pathname) ? shownMove.from : null;
}

// The page in view: the one the last move in view opened, or before any
// move, the address. While a move is not yet in view, the address already
// names the next page, and Back can still undo that move.
function pageInView() {
  return shownMove.to ?? window.location.pathname;
}

// The page that the move under way started on, until the move's last page is
// in view; else null. A redirect continues the move it ends
// (PortalUpdateGate): after Back from the dashboard to /recap/:token, the
// redirect is in view when the report it redirects to asks for its code, and
// the move from the dashboard still asks for that code. For a move with no
// redirect, that page is the page in view.
function moveUnderWayFrom() {
  const { to, origin } = renderedMove;
  return to == null || samePage(to, shownMove.to) ? null : origin;
}

// Whether the staff rules apply (see the top of this file): in Waves Admin,
// which can open a customer link such as a report in its own webview; while
// the page in view or the address is a staff page, or a page that a move from
// a field page opened, which never reloads by itself; and while a move that
// started on a staff page is under way, through its redirects too
// (moveUnderWayFrom). App.jsx and LazyPanel.jsx ask it too, for a page or a
// part whose code is missing.
export function staffTab() {
  return isWavesAdminApp()
    || isAdminPath(moveUnderWayFrom())
    || [pageInView(), window.location.pathname]
      .some((pathname) => isAdminPath(pathname) || isFieldPath(moveFromFor(pathname)));
}

// Runs `load`, an import asked for on a staff tab: a page's code
// (lazyWithRetry), a part's (lazyPanel) or a legacy panel's
// (CustomersPageV2.jsx). It counts as on its way until it settles, so the
// handler leaves every import to fail meanwhile (see the top of this file).
export async function trackStaffImport(load) {
  const entry = {};
  staffImports.add(entry);
  try {
    return await load();
  } finally {
    staffImports.delete(entry);
  }
}

// One set of document listeners notes each use of the page in view for the
// whole tab (isPageUse, lib/portalReload.js): it records the page used
// (usedOnPageInView), then tells each listener (onPageUse), such as a
// Reload button that clears what it named (usePageUse in
// components/PortalUpdate.jsx). It listens while anyone asks: main.jsx for
// the page load (watchPageUse), and each listener while it listens.
const pageUseListeners = new Set();
let pageUseWatchers = 0;

function noteUse(event) {
  if (!isPageUse(event)) return;
  usedPath = pageInView();
  [...pageUseListeners].forEach((note) => note());
}

export function watchPageUse() {
  if (pageUseWatchers === 0) PAGE_USE_EVENTS.forEach((type) => document.addEventListener(type, noteUse, true));
  pageUseWatchers += 1;
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    pageUseWatchers -= 1;
    if (pageUseWatchers === 0) PAGE_USE_EVENTS.forEach((type) => document.removeEventListener(type, noteUse, true));
  };
}

// Calls `listener` at each use of the page in view, until the stop it
// returns.
export function onPageUse(listener) {
  const note = () => listener();
  pageUseListeners.add(note);
  const stopWatching = watchPageUse();
  return () => {
    pageUseListeners.delete(note);
    stopWatching();
  };
}

// Whether the tab was used on the page in view since it came into view: a
// tap, a key or a field change anywhere but on a Reload control. A page keeps
// unsaved work in many ways: a field, a toggle, a picked slot, a signature on
// a canvas, a shape drawn on a map. No list of controls names them all, so
// after any use a reload asks once first. Only the staff rules ask this, so
// it reads the record alone: the Reload bar, on a staff page; the staff retry
// screen (App.jsx); and a page whose code is missing, asked for on a staff
// tab (reloadForMissingCode), which keeps the staff rules once in view, a
// customer page included. A page move ends the use once it is in view
// (notePageInView). Both paths read the page in view, so they share one
// spelling.
export function usedOnPageInView() {
  return usedPath === pageInView();
}

// Whether the staff rules bar the reload of a page whose code is missing
// (see the top of this file): the page in view or the address bars it, each
// judged by the move that opened it. Only a page asked for on a staff tab
// asks (reloadForMissingCode), so it applies whatever that page is: once a
// move from a field page, such as Back, opened a customer page, that move
// still bars it.
function staffSelfReloadBarred() {
  return [pageInView(), window.location.pathname]
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
// that loaded would reload the tab at every load. That path counts until a
// move to another page comes into view, which clears the flag too
// (notePageInView). A page that loads on another path does not end it: Back
// can still undo the move that page belongs to. The path counts in any
// spelling of its page (samePage). Throws when storage is blocked.
function chunkReloadAttempted() {
  return samePage(window.location.pathname, reloadedPath) || Boolean(sessionStorage.getItem(CHUNK_RELOAD_FLAG));
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
// still counts until a move away from it is in view (chunkReloadAttempted).
// Best effort: blocked storage must not fail a page whose code loaded. While
// a reload for a missing chunk is under way, a load does not count: the flag
// must reach the page load that reload opens. Vite still imports a page
// whose stylesheet is missing, and that script can load before the reload
// lands.
export function noteChunkLoaded() {
  if (reloadPending) return;
  clearChunkReloadFlag();
}

function clearChunkReloadFlag() {
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
  // A staff tab, or code a staff tab asked for still on its way: the import
  // fails as it would with no handler, and the page or part that asked for
  // it decides (see the top of this file).
  if (staffTab() || staffImports.size > 0) return;
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
// first), 'manual' on a page that never reloads by itself, or what else
// holds the tab: a registered hold's name, or 'offline' while the browser
// reports itself offline (blockersBesideWork in lib/portalReload.js). The
// wait for open work ends none of them, so the page does not wait while one
// stands, as a page move does not, and its wait ends once one comes up. Null
// when it can.
function selfReloadRuledOut() {
  try {
    if (chunkReloadAttempted()) return 'reloaded';
  } catch {
    return 'storage';
  }
  if (usedOnPageInView()) return 'page-use';
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

// A page whose code is missing, asked for on a staff tab (App.jsx): waits for
// open work, as a page move does, then reloads once, as for a stale chunk,
// when nothing holds the tab. It keeps the staff rules, also once the move
// that asked for it, such as Back, opened a customer page. It waits only
// while a reload can follow: otherwise its screen comes at once, and the wait
// ends at its next look once none can (the page closed or moved, or a reason
// of selfReloadRuledOut came up). `pathname`: the path of the route whose
// code is missing, as the router rendered it (App.jsx). It reloads only while
// the address names that page, before and after the wait (samePage). Back
// moves the address on at once, even before this page's effect starts, but
// the routes keep this page in view until the next page's code loads: a
// reload then would open the next page and spend the one reload on it. With
// no `pathname`, it never reloads. Resolves why it did not reload: 'moved'
// when the address names another page, or the page closed during the wait;
// then 'reloaded', whatever holds the tab (after the one reload a missing
// page is an outage, so its screen offers the connection retry); then what
// holds the tab; then the other reasons of selfReloadRuledOut. The screen for
// 'moved' shows until the next page comes into view.
export async function reloadForMissingCode({
  pathname,
  current = () => true,
  reload = () => window.location.reload(),
  now,
} = {}) {
  const atPage = () => samePage(window.location.pathname, pathname);
  if (!atPage()) return 'moved';
  const noReload = () => !current() || !atPage() || Boolean(selfReloadRuledOut());
  if (!noReload()) await waitForWork({ now, done: noReload });
  if (!current() || !atPage()) return 'moved';
  // From here to the reload, all in one turn: no work can start and no hold
  // can register between the last look and the reload. The wait can also
  // outlast a use of the page or another reload.
  const reason = selfReloadRuledOut();
  if (reason === 'reloaded') return reason;
  const blocker = reloadBlocker();
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
  staffImports.clear();
}
