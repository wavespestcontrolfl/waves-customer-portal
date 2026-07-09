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

// jsdom in this runner exposes a localStorage whose methods are not callable
// (localStorage.getItem is not a function), which breaks any component that
// reads it on mount — #2463's NotificationBell specs shipped red on main
// because of this. Individual suites already work around it per-file with
// vi.stubGlobal (ReportViewPage.render.test.jsx et al); provide a functional
// in-memory default here so a fresh test file doesn't inherit the trap.
// Guarded: only installs when the real one is unusable, and a suite that
// stubs its own localStorage still wins (vi.stubGlobal overrides globalThis).
if (typeof window !== 'undefined') {
  let usable = false;
  try {
    usable = typeof window.localStorage?.getItem === 'function';
  } catch {
    usable = false; // jsdom can throw SecurityError on opaque origins
  }
  if (!usable) {
    const store = new Map();
    const localStorageShim = {
      getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
      setItem: (k, v) => { store.set(String(k), String(v)); },
      removeItem: (k) => { store.delete(String(k)); },
      clear: () => { store.clear(); },
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
    // Plain assignment throws (read-only property in this environment) —
    // defineProperty is required for both targets.
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageShim });
    if (globalThis !== window) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageShim });
    }
  }
}
