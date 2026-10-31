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
// A navigation the app shell starts (an app link or a push tap) opens the same
// window. WebKit cancels every chunk load still in flight when a navigation
// starts, and each cancelled import reaches vite:preloadError like a stale
// chunk. Reloading then replaced the navigation with the page being left: on
// 2026-10-31 every iPhone app link landed on Home, because the link navigates
// at launch while the home page chunks are still loading.

export const CHUNK_RELOAD_FLAG = 'chunk-reload-attempted';

// Long enough for a slow navigation to commit. It bounds how long a page whose
// navigation never committed keeps placeholders instead of reloading.
const NAVIGATION_WINDOW_MS = 30000;

let reloadPending = false;
let navigatingUntil = 0;

function pageNavigating() {
  return Date.now() < navigatingUntil;
}

export function isStaleChunkReloadPending() {
  return reloadPending || pageNavigating();
}

export function markStaleChunkReloadPending() {
  reloadPending = true;
}

// Call right before location.assign. Returns the call that closes the window
// when the navigation did not start.
export function markPageNavigating() {
  const until = Date.now() + NAVIGATION_WINDOW_MS;
  navigatingUntil = until;
  return () => {
    if (navigatingUntil === until) navigatingUntil = 0;
  };
}

// One-shot guard (App.jsx clears the flag on a successful lazy load) so a
// genuine outage still surfaces instead of reload-looping.
export function handleVitePreloadError(event, reload = () => window.location.reload()) {
  if (pageNavigating()) {
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
}
