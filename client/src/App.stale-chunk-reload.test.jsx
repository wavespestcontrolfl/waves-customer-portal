// @vitest-environment jsdom
import React, { Suspense, lazy } from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reported = vi.hoisted(() => ({ calls: [] }));
vi.mock('./lib/reportError', () => ({ reportError: (...args) => { reported.calls.push(args); } }));
vi.mock('./hooks/useAuth', () => ({ AuthProvider: ({ children }) => children, useAuth: () => null }));
vi.mock('./components/BiometricGate', () => ({ default: ({ children }) => children, useBiometricLock: () => false }));
vi.mock('./components/InstallPrompt', () => ({ default: () => null }));
vi.mock('./components/analytics/PublicFunnelTracking', () => ({ default: () => null }));
vi.mock('./glass/glass-engine', () => ({ useGlassSurface: () => {} }));
import { PageErrorBoundary, lazyWithRetry } from './App';
import { PortalUpdateGate } from './components/PortalUpdate';
import {
  CHUNK_RELOAD_FLAG,
  handleVitePreloadError,
  isChunkError,
  isStaleChunkReloadPending,
  markPageNavigating,
  reloadForMissingCode,
  resetStaleChunkReloadForTests,
  watchPageUse,
} from './lib/staleChunkReload';
import { registerReloadHold } from './lib/reloadHolds';
import { installPortalVersionWatch, resetPortalVersionForTests } from './lib/portalVersion';

// Held work on a staff tab (lib/reloadHolds.js), as a manual card charge
// waiting on the card check registers it.
let holding = false;
registerReloadHold('card-payment', () => holding);

function missingChunk() {
  return Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Page-old.js'));
}

// A tap as a browser sends it: pointerdown, then click.
function tap(element) {
  fireEvent.pointerDown(element);
  fireEvent.click(element);
}

function preloadErrorEvent() {
  return new Event('vite:preloadError', { cancelable: true });
}

// What Vite 5.4 hands back once the handler calls preventDefault(): the
// dynamic import resolves undefined instead of rejecting.
function swallowedImport() {
  return Promise.resolve(undefined);
}

function renderInBoundary(Page) {
  return render(
    <PageErrorBoundary>
      <Suspense fallback={<div>Suspended</div>}>
        <Page />
      </Suspense>
    </PageErrorBoundary>,
  );
}

// #8121's gate around the routes, as App.jsx has it, with the /admin index's
// redirect. Hands back a move: a path, or -1 for Back.
function renderGate(entries) {
  let navigate;
  function Navigator() {
    navigate = useNavigate();
    return null;
  }
  function Where() {
    return <div>{useLocation().pathname}</div>;
  }
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <PortalUpdateGate fallback={<div>Gate placeholder</div>}>
        <Navigator />
        <Routes>
          <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </PortalUpdateGate>
    </MemoryRouter>,
  );
  return (to) => act(() => { navigate(to); });
}

beforeEach(() => {
  holding = false;
  sessionStorage.clear();
  resetStaleChunkReloadForTests();
  resetPortalVersionForTests();
  reported.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

test('the first stale-chunk preload error reloads once and marks the reload pending', () => {
  const reload = vi.fn();
  const first = preloadErrorEvent();
  handleVitePreloadError(first, reload);
  expect(first.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(isStaleChunkReloadPending()).toBe(true);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');

  const second = preloadErrorEvent();
  handleVitePreloadError(second, reload);
  expect(second.defaultPrevented).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('a page tab loaded with plain React.lazy shows the loading placeholder, not the crash screen, while the reload runs', async () => {
  handleVitePreloadError(preloadErrorEvent(), vi.fn());
  const StaleTab = lazy(swallowedImport);
  renderInBoundary(StaleTab);
  expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(reported.calls).toHaveLength(0);
});

test('a lazyWithRetry page swallowed by the preload handler holds the placeholder and keeps the one-shot flag', async () => {
  handleVitePreloadError(preloadErrorEvent(), vi.fn());
  const StalePage = lazyWithRetry(swallowedImport);
  renderInBoundary(StalePage);
  expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
});

test('a chunk that fails after a CSS preload already started the reload shows the placeholder, not the retry screen', async () => {
  handleVitePreloadError(preloadErrorEvent(), vi.fn());
  const StalePage = lazyWithRetry(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Page-old.js')));
  renderInBoundary(StalePage);
  expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
  expect(screen.queryByText('Couldn’t load this page')).not.toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
});

test('while an app link navigates away, a cancelled chunk holds the placeholder and never reloads over the navigation', async () => {
  markPageNavigating();
  const reload = vi.fn();
  const cancelled = preloadErrorEvent();
  handleVitePreloadError(cancelled, reload);
  expect(cancelled.defaultPrevented).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  const LeavingPage = lazyWithRetry(swallowedImport);
  renderInBoundary(LeavingPage);
  expect(await screen.findByRole('status')).toHaveTextContent('Loading...');
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(reported.calls).toHaveLength(0);
});

test('a navigation that has held no chunk does not hide a real page crash', async () => {
  markPageNavigating(vi.fn());
  function Broken() { throw new TypeError('real render bug'); }
  renderInBoundary(Broken);
  expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  expect(reported.calls).toHaveLength(1);
});

test('a chunk held during a navigation that never commits is recovered by a reload when the window ends', () => {
  vi.useFakeTimers();
  const heal = vi.fn();
  markPageNavigating(heal);
  handleVitePreloadError(preloadErrorEvent(), vi.fn());
  vi.advanceTimersByTime(29999);
  expect(heal).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(heal).toHaveBeenCalledTimes(1);
  expect(isStaleChunkReloadPending()).toBe(true);
});

test('a navigation window with no held chunk ends without a reload, and later stale chunks reload as before', () => {
  vi.useFakeTimers();
  const heal = vi.fn();
  markPageNavigating(heal);
  vi.advanceTimersByTime(30000);
  expect(heal).not.toHaveBeenCalled();
  const reload = vi.fn();
  const stale = preloadErrorEvent();
  handleVitePreloadError(stale, reload);
  expect(stale.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('with no reload pending, a real page crash still shows the crash screen and is reported', async () => {
  function Broken() { throw new TypeError('real render bug'); }
  renderInBoundary(Broken);
  expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  expect(screen.getByText('real render bug')).toBeInTheDocument();
  expect(reported.calls).toHaveLength(1);
  expect(reported.calls[0][1]).toMatchObject({ context: 'PageErrorBoundary' });
});

test('with no reload pending, a lazy page that loads normally clears the one-shot flag', async () => {
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  const Page = lazyWithRetry(() => Promise.resolve({ default: () => <div>Loaded page</div> }));
  renderInBoundary(Page);
  expect(await screen.findByText('Loaded page')).toBeInTheDocument();
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
});

test('the missing-code check knows the error of each browser and of a Vite stylesheet, and nothing else', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: /assets/Page-old.js',
    'Importing a module script failed.',
    'error loading dynamically imported module: /assets/Page-old.js',
    'Unable to preload CSS for /assets/Page-old.css',
    'Loading chunk 7 failed. (ChunkLoadError)',
  ]) expect(isChunkError(new Error(message))).toBe(true);
  expect(isChunkError(new TypeError('real render bug'))).toBe(false);
  expect(isChunkError(null)).toBe(false);
});

// A route can load in parts: a page, then a part that opens with it. The page
// that loads clears the one-shot flag before the part still missing fails.
function shellAround(Page, label) {
  return lazyWithRetry(() => Promise.resolve({
    default: () => <div>{label}<Suspense fallback={null}><Page /></Suspense></div>,
  }));
}

test('on a customer page too, after the one reload a page still missing under a shell that loaded gets the retry screen, not another reload', async () => {
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  resetStaleChunkReloadForTests(); // the page load the one reload opened
  renderInBoundary(shellAround(lazyWithRetry(missingChunk), 'Portal shell'));
  expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
  expect(document.getElementById('chunk-reload-toast')).toBeNull();
  expect(isStaleChunkReloadPending()).toBe(false);
});

// A page whose stylesheet is missing: the preload error starts the reload,
// and Vite still imports the page's script, which can load before the reload
// lands.
test('a chunk that loads while the reload for a missing chunk is under way keeps the one-shot flag', async () => {
  const reload = vi.fn();
  handleVitePreloadError(preloadErrorEvent(), reload);
  expect(reload).toHaveBeenCalledTimes(1);
  renderInBoundary(lazyWithRetry(() => Promise.resolve({ default: () => <div>Loaded page</div> })));
  expect(await screen.findByText('Loaded page')).toBeInTheDocument();
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  resetStaleChunkReloadForTests(); // the page load the one reload opened
  const again = preloadErrorEvent();
  handleVitePreloadError(again, reload);
  expect(again.defaultPrevented).toBe(false);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('with session storage blocked, a page whose code loaded still renders', async () => {
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage blocked'); });
  renderInBoundary(lazyWithRetry(() => Promise.resolve({ default: () => <div>Loaded page</div> })));
  expect(await screen.findByText('Loaded page')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
});

test('on a customer page with session storage blocked, a missing chunk gets the retry screen, not a reload, and Try Again reloads', async () => {
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('storage blocked'); });
  }
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  try {
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
    expect(document.getElementById('chunk-reload-toast')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a customer page keeps its stale-chunk reload while a staff tab hold is open, and after a use of the page', () => {
  holding = true;
  const stop = watchPageUse(document);
  try {
    fireEvent.pointerDown(document.body);
    const reload = vi.fn();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

// A staff page obeys the holds of an out-of-date tab (lib/portalReload.js).
describe('on a staff page', () => {
  let reload;
  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('with nothing open, a stale-chunk preload error reloads at once, as on every page', () => {
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('held work keeps the tab: the preload error neither reloads nor swallows the import, and leaves the one-shot flag', () => {
    holding = true;
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(isStaleChunkReloadPending()).toBe(false);
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('a request still open keeps the tab too; the page whose code is missing waits for it, then reloads once', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/auth/me');
      const stale = preloadErrorEvent();
      handleVitePreloadError(stale, reload);
      expect(stale.defaultPrevented).toBe(false);
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('Loading the new version...')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      pending[0]({ headers: new Headers() });
      await read;
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
      expect(isStaleChunkReloadPending()).toBe(true);
    } finally {
      uninstall();
    }
  });

  test('a use of the page while a page whose code is missing waits keeps the tab: the retry screen says new version, and Reload asks about the page first', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    const stop = watchPageUse(document);
    try {
      const read = target.fetch('/api/admin/auth/me');
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('Loading the new version...')).toBeInTheDocument();
      fireEvent.input(document.body);
      pending[0]({ headers: new Headers() });
      await read;
      expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
      tap(screen.getByRole('button', { name: 'Reload' }));
      expect(screen.getByText('Anything not saved on this page will be lost.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      tap(screen.getByRole('button', { name: 'Reload anyway' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      uninstall();
    }
  });

  test('a page whose code is missing while held work keeps the tab says the portal has a new version; Reload names the work, then Reload anyway reloads', async () => {
    holding = true;
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t load this page')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('A card payment is still going through.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('after the one reload for a missing chunk already ran, the page shows the retry screen, not another reload', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('after the one reload, a chunk still missing under a page that loaded gets the retry screen, not another reload', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    renderInBoundary(shellAround(lazyWithRetry(missingChunk), 'Loaded page'));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByText('Loaded page')).toBeInTheDocument();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page that loads on another path ends that count, so a later missing chunk reloads at once again', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/schedule', reload });
    renderInBoundary(lazyWithRetry(() => Promise.resolve({ default: () => <div>Schedule page</div> })));
    expect(await screen.findByText('Schedule page')).toBeInTheDocument();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Waves Admin and the field pages never reload by themselves, as at a page
  // move (selfReloadBarred, lib/portalReload.js).
  test('on a field page a missing chunk never reloads by itself: the page says new version, and its Reload reloads', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/today/protocols', reload });
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    tap(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('on a field page a page whose code is missing does not wait for open work: it names that work at once', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/today', reload });
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      target.fetch('/api/admin/today');
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
      tap(screen.getByRole('button', { name: 'Reload' }));
      expect(screen.getByText('A request is still on its way.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  // The gate notes the page each move leaves (notePageMove). Each move below
  // ends on /admin/dashboard, the location this describe stubs.
  test('Back from a field page, with no use of it, opens a page that never reloads by itself', () => {
    const move = renderGate(['/admin/dashboard', '/admin/today']);
    move(-1);
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a redirect continues the move away from a field page: Today, then /admin, then the dashboard', () => {
    const move = renderGate(['/admin/today']);
    move('/admin');
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a move between other staff pages, with nothing open, still reloads at once', () => {
    const move = renderGate(['/admin/schedule']);
    move('/admin/dashboard');
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('in Waves Admin a missing chunk never reloads by itself', () => {
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
    try {
      const stale = preloadErrorEvent();
      handleVitePreloadError(stale, reload);
      expect(stale.defaultPrevented).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      delete window.webkit;
    }
  });

  test('offline, a page whose code is missing asks to check the connection, and its Retry names the offline device', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('This device is offline. A reload may show an error page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload anyway' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page used since it opened keeps the tab, so a missing part asks first; after a move, a missing page reloads at once', () => {
    const stop = watchPageUse(document);
    try {
      fireEvent.input(document.body);
      const stale = preloadErrorEvent();
      handleVitePreloadError(stale, reload);
      expect(stale.defaultPrevented).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
      const next = preloadErrorEvent();
      handleVitePreloadError(next, reload);
      expect(next.defaultPrevented).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('a tap on a Reload control is no use of the page, so a missing chunk still reloads at once', () => {
    const stop = watchPageUse(document);
    const control = document.body.appendChild(document.createElement('button'));
    control.setAttribute('data-portal-reload-prompt', '');
    try {
      fireEvent.pointerDown(control);
      const stale = preloadErrorEvent();
      handleVitePreloadError(stale, reload);
      expect(stale.defaultPrevented).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      control.remove();
    }
  });

  test('a use of the page after the retry screen named the work clears it, so its Reload asks again', async () => {
    holding = true;
    renderInBoundary(lazyWithRetry(missingChunk));
    tap(await screen.findByRole('button', { name: 'Reload' }));
    expect(screen.getByText('A card payment is still going through.')).toBeInTheDocument();
    fireEvent.input(document.body);
    expect(screen.getByText('The portal has a new version.')).toBeInTheDocument();
    tap(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).not.toHaveBeenCalled();
    // A tap on the screen's own button is no use of the page.
    tap(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a mixed-case staff URL gets the staff retry screen, which asks before it reloads', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/ADMIN/Dashboard', reload });
    holding = true;
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    tap(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.getByText('A card payment is still going through.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a plain React.lazy whose code is missing gets the same recovery, not the crash screen, and is not reported', async () => {
    holding = true;
    renderInBoundary(lazy(missingChunk));
    expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(reported.calls).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a real crash on a staff page still shows the crash screen and is reported', async () => {
    function Broken() { throw new TypeError('real render bug'); }
    renderInBoundary(Broken);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(reported.calls).toHaveLength(1);
  });

  test('a page that closed during the wait does not reload', async () => {
    await expect(reloadForMissingCode({ current: () => false, reload })).resolves.toBe('moved');
    expect(reload).not.toHaveBeenCalled();
  });

  test('without session storage there is no one-shot guard, so the tab never reloads by itself', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    await expect(reloadForMissingCode({ reload })).resolves.toBe('storage');
    expect(reload).not.toHaveBeenCalled();
  });
});
