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

export const CHUNK_RELOAD_FLAG = 'chunk-reload-attempted';

let reloadPending = false;

export function isStaleChunkReloadPending() {
  return reloadPending;
}

export function markStaleChunkReloadPending() {
  reloadPending = true;
}

// One-shot guard (App.jsx clears the flag on a successful lazy load) so a
// genuine outage still surfaces instead of reload-looping.
export function handleVitePreloadError(event, reload = () => window.location.reload()) {
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
}
