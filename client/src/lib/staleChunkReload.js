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

export const CHUNK_RELOAD_FLAG = 'chunk-reload-attempted';

// Long enough for a slow navigation to commit. It bounds how long a page whose
// navigation never committed keeps placeholders before it reloads.
const NAVIGATION_WINDOW_MS = 30000;

let reloadPending = false;
let navigatingUntil = 0;
let chunkHeld = false;

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

// One-shot guard (App.jsx clears the flag on a successful lazy load) so a
// genuine outage still surfaces instead of reload-looping.
export function handleVitePreloadError(event, reload = () => window.location.reload()) {
  if (pageNavigating()) {
    chunkHeld = true;
    event.preventDefault();
    return;
  }
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_FLAG)) return;
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  } catch {
    return;
  }
  markStaleChunkReloadPending();
  event.preventDefault();
  reload();
}

// Test-only reset; module state otherwise lives for the page's lifetime.
export function resetStaleChunkReloadForTests() {
  reloadPending = false;
  navigatingUntil = 0;
  chunkHeld = false;
}
