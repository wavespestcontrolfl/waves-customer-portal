// Vitest global setup.
//
// jsdom does not implement window.matchMedia. The liquid-glass scene
// (useGlassSurface → applyGlassScene / attachGlassPointerFx) reads it for the
// prefers-reduced-motion check, and glass now mounts unconditionally on every
// customer surface — so any component/page test that renders one of those
// surfaces needs the API present. Provide a standard no-op shim. Guarded so it
// never overrides a test that installs its own matchMedia mock, and skipped in
// node-environment test files where `window` is undefined.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

// jsdom also omits IntersectionObserver, which the estimate glass theme uses for
// its scroll-reveal / stat count-up (now mounted in every estimate test). No-op
// stub — the reveal is decorative, so tests only need it to not throw.
if (typeof window !== 'undefined' && !window.IntersectionObserver) {
  class IntersectionObserverStub {
    observe() {}

    unobserve() {}

    disconnect() {}

    takeRecords() {
      return [];
    }
  }
  window.IntersectionObserver = IntersectionObserverStub;
  globalThis.IntersectionObserver = IntersectionObserverStub;
}
