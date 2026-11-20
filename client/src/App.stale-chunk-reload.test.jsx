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
  markStaleChunkReloadPending,
  noteChunkLoaded,
  notePageInView,
  reloadForMissingCode,
  resetStaleChunkReloadForTests,
  watchPageUse,
} from './lib/staleChunkReload';
import { registerReloadHold } from './lib/reloadHolds';
import { reloadForNewBuild, waitForWork } from './lib/portalReload';
import { installPortalVersionWatch, noteServerAnswer, resetPortalVersionForTests } from './lib/portalVersion';

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

// The server names a newer build than this page loaded, as after a deploy
// (lib/portalVersion.js). Only then does a screen for missing code say the
// portal has a new version. #8121's gate then also reloads at a staff move,
// so no gate test names one.
function nameNewerBuild() {
  act(() => { noteServerAnswer(new Headers({ 'X-Portal-Build': 'bbb222bbb222', 'X-Portal-Boot': '2000' })); });
}

// What Vite 5.4 hands back once the handler calls preventDefault(): the
// dynamic import resolves undefined instead of rejecting.
function swallowedImport() {
  return Promise.resolve(undefined);
}

// A page as App.jsx renders it: inside the router, at the address.
function renderInBoundary(Page) {
  return render(
    <MemoryRouter initialEntries={[window.location.pathname]}>
      <PageErrorBoundary>
        <Suspense fallback={<div>Suspended</div>}>
          <Page />
        </Suspense>
      </PageErrorBoundary>
    </MemoryRouter>,
  );
}

// #8121's gate around the routes, as App.jsx has it, with the /admin index's
// redirect. Hands back a move: a path, or -1 for Back. The Blog page's code
// never arrives. With `transitions`, each move is a transition, as
// BrowserRouter makes it in App.jsx: a move to Blog then stays out of view,
// and its render is dropped when another move replaces it. `pages`: the page
// for a path, such as one whose code is missing, in place of the default.
function renderGate(entries, { transitions = false, pages = {} } = {}) {
  let navigate;
  function Navigator() {
    navigate = useNavigate();
    return null;
  }
  function Where() {
    return <div>{useLocation().pathname}</div>;
  }
  const Blog = lazy(() => new Promise(() => {}));
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1} future={{ v7_startTransition: transitions }}>
      <PortalUpdateGate fallback={<div>Gate placeholder</div>}>
        <Navigator />
        <Suspense fallback={<div>Loading the page</div>}>
          <Routes>
            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            {Object.entries({ '/admin/blog': Blog, ...pages }).map(([path, Page]) => (
              <Route key={path} path={path} element={<Page />} />
            ))}
            <Route path="*" element={<Where />} />
          </Routes>
        </Suspense>
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
  // The build this page loaded; no answer names a newer one until a test does.
  document.head.insertAdjacentHTML('beforeend', '<meta name="portal-build" content="aaa111aaa111">');
  reported.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

// Only code a staff tab asked for stops the handler: a customer page's own
// import on its way gets the reload at once, as on main.
test('a customer page\'s own import on its way does not stop the stale-chunk reload', () => {
  renderInBoundary(lazyWithRetry(() => new Promise(() => {})));
  const reload = vi.fn();
  const stale = preloadErrorEvent();
  handleVitePreloadError(stale, reload);
  expect(stale.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
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

  // The handler cannot tell which import failed, so on a staff page it never
  // reloads: the page whose code is missing decides, while it is mounted.
  test('with nothing open, the preload error leaves the import to fail, and the page whose code is missing reloads once', async () => {
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    renderInBoundary(lazyWithRetry(missingChunk));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  });

  // Back to the page in view while the next page's code loads: React drops
  // that move, and its import can fail later, with the page Back returned to
  // in view. A reload then would spend the one reload on that page.
  test('the import of a move that Back dropped fails after Back: the page in view stays, with no reload, and the one-shot flag stays clear', async () => {
    let navigate;
    function Navigator() {
      navigate = useNavigate();
      return null;
    }
    let failBlog;
    const Blog = lazyWithRetry(() => new Promise((_, reject) => { failBlog = reject; }));
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']} future={{ v7_startTransition: true }}>
        <PortalUpdateGate fallback={<div>Gate placeholder</div>}>
          <Navigator />
          <PageErrorBoundary>
            <Suspense fallback={<div>Loading the page</div>}>
              <Routes>
                <Route path="/admin/dashboard" element={<div>Dashboard page</div>} />
                <Route path="/admin/blog" element={<Blog />} />
              </Routes>
            </Suspense>
          </PageErrorBoundary>
        </PortalUpdateGate>
      </MemoryRouter>,
    );
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
    act(() => { navigate('/admin/blog'); });
    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
    act(() => { navigate(-1); });
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    await act(async () => { failBlog(new TypeError('Failed to fetch dynamically imported module: /assets/Blog-old.js')); });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    expect(screen.getByText('Dashboard page')).toBeInTheDocument();
    expect(screen.queryByText('Check your connection and try again.')).not.toBeInTheDocument();
  });

  // Back can open a customer page while a staff page's code is on its way.
  // The handler cannot tell which import failed, so while code a staff tab
  // asked for is on its way it leaves every import to fail, and that page,
  // no longer mounted, reloads nothing.
  test('a staff page\'s import that fails after Back opened a customer page reloads nothing: the customer page stays, with no toast, and the one-shot flag stays clear', async () => {
    let failBlog;
    const move = renderGate(['/'], {
      transitions: true,
      pages: { '/admin/blog': lazyWithRetry(() => new Promise((_, reject) => { failBlog = reject; })) },
    });
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
    move('/admin/blog');
    vi.stubGlobal('location', { ...window.location, pathname: '/', reload });
    move(-1);
    expect(screen.getByText('/')).toBeInTheDocument();
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    await act(async () => { failBlog(new TypeError('Failed to fetch dynamically imported module: /assets/Blog-old.js')); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stale.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    expect(document.getElementById('chunk-reload-toast')).toBeNull();
    expect(screen.getByText('/')).toBeInTheDocument();
    // That import settled: the customer page's own missing chunk reloads at
    // once again, as on main.
    const own = preloadErrorEvent();
    handleVitePreloadError(own, reload);
    expect(own.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The handler then leaves the customer page's own import to fail too: the
  // page that asked for it, a customer page, still reloads, as on main.
  test('while a staff page\'s code is on its way, a customer page whose own code fails still reloads once, through that page: the toast, then the reload', async () => {
    renderInBoundary(lazyWithRetry(() => new Promise(() => {}))); // asked for on this staff page
    vi.stubGlobal('location', { ...window.location, pathname: '/', reload });
    notePageInView('/admin/dashboard', '/');
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    try {
      renderInBoundary(lazyWithRetry(missingChunk));
      await waitFor(() => expect(document.getElementById('chunk-reload-toast')).not.toBeNull());
      expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 2500 });
    } finally {
      document.getElementById('chunk-reload-toast')?.remove();
    }
  });

  test('held work keeps the tab: a page whose code is missing does not reload, and leaves the one-shot flag', async () => {
    holding = true;
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('card-payment');
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
      renderInBoundary(lazyWithRetry(missingChunk));
      // No answer named a newer build: the wait does not say new version.
      expect(await screen.findByText('Loading...')).toBeInTheDocument();
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
      nameNewerBuild();
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
    nameNewerBuild();
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

  // A chunk can also fail from an asset fault or an outage. The screen says
  // new version only when an answer names a newer build, as the Reload bar.
  test('with no newer build named, a page whose code is missing asks to check the connection; once an answer names one, it says new version', async () => {
    holding = true;
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('The portal has a new version.')).not.toBeInTheDocument();
    nameNewerBuild();
    expect(screen.getByText('The portal has a new version.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('after the one reload for a missing chunk already ran, the page shows the retry screen, not another reload, and asks to check the connection even with a newer build named', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    nameNewerBuild();
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  // A page waits for open work only when a reload can follow.
  test('after the one reload, a page whose code is missing does not wait for open work: the connection retry comes at once, and Retry names the work', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      target.fetch('/api/admin/dashboard');
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      tap(screen.getByRole('button', { name: 'Retry' }));
      expect(screen.getByText('A request is still on its way.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  test('a page used before its code failed does not wait for open work: it says new version at once, and Reload names the work and the page', async () => {
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    const stop = watchPageUse(document);
    try {
      nameNewerBuild();
      fireEvent.input(document.body);
      target.fetch('/api/admin/dashboard');
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      tap(screen.getByRole('button', { name: 'Reload' }));
      expect(screen.getByText('A request is still on its way. Anything not saved on this page will be lost.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      stop();
      uninstall();
    }
  });

  test('after the one reload, a chunk still missing under a page that loaded gets the retry screen, not another reload', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    renderInBoundary(shellAround(lazyWithRetry(missingChunk), 'Loaded page'));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.getByText('Loaded page')).toBeInTheDocument();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('reloaded');
    expect(reload).not.toHaveBeenCalled();
  });

  // A move changes the address before its page is in view, and Back can
  // still undo it. A page that loads meanwhile does not end the count.
  test('a page that loads on another path while its move is not yet in view keeps that count: Back to the reopened page gets no second reload', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    notePageInView(null, '/admin/dashboard');
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/schedule', reload });
    renderInBoundary(lazyWithRetry(() => Promise.resolve({ default: () => <div>Schedule page</div> })));
    expect(await screen.findByText('Schedule page')).toBeInTheDocument();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('reloaded');
    expect(reload).not.toHaveBeenCalled();
  });

  // Waves Admin and the field pages never reload by themselves, as at a page
  // move (selfReloadBarred, lib/portalReload.js).
  test('on a field page a missing chunk never reloads by itself: the page says new version, and its Reload reloads', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/today/protocols', reload });
    nameNewerBuild();
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    tap(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('on a field page a page whose code is missing does not wait for open work: it names that work at once', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/today', reload });
    nameNewerBuild();
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

  // The gate notes each move (notePageMove, notePageInView). Each move below
  // ends on /admin/dashboard, the location this describe stubs, unless a
  // test stubs another.
  test('Back from a field page, with no use of it, opens a page that never reloads by itself, from the moment the address changes: its missing code gets the retry screen, and the one-shot flag stays clear', async () => {
    nameNewerBuild();
    const move = renderGate(['/admin/dashboard', '/admin/today'], { pages: { '/admin/dashboard': lazyWithRetry(missingChunk) } });
    // Back changes the address first: it names the dashboard, as this
    // describe stubs it, while Today is still in view.
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('manual');
    move(-1);
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('a redirect continues the move away from a field page: Today, then /admin, then the dashboard, whose missing code gets the retry screen', async () => {
    nameNewerBuild();
    const move = renderGate(['/admin/today'], { pages: { '/admin/dashboard': lazyWithRetry(missingChunk) } });
    move('/admin');
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('a move between other staff pages, with nothing open, still lets a page whose code is missing reload at once', async () => {
    const move = renderGate(['/admin/schedule']);
    move('/admin/dashboard');
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a move ends the use of the page it leaves: Back to a page used before the move, with no use since, reloads at once', async () => {
    const stop = watchPageUse(document);
    try {
      const move = renderGate(['/admin/dashboard']);
      fireEvent.input(document.body);
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('page-use');
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/reviews', reload });
      move('/admin/reviews');
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
      move(-1);
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  // React drops the render of a move that Back undoes while the new page's
  // code loads: the page stays in view, with its use and its move.
  test('a move that never comes into view keeps the use of the page: Back while the next page loads', async () => {
    const stop = watchPageUse(document);
    try {
      const move = renderGate(['/admin/dashboard'], { transitions: true });
      fireEvent.input(document.body);
      move('/admin/blog');
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      move(-1);
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('page-use');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  // While a move is not yet in view, the address already names the next
  // page. A use then is a use of the page still in view.
  test('a use while the next page loads counts for the page in view: Back to that page keeps the tab', async () => {
    const stop = watchPageUse(document);
    try {
      const move = renderGate(['/admin/dashboard'], { transitions: true });
      move('/admin/blog');
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      fireEvent.input(document.body);
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/dashboard', reload });
      move(-1);
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('page-use');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  // The page the use was on closes as the next page comes into view, so the
  // reload drops nothing the move did not.
  test('a use while the next page loads: that page\'s missing code reloads only once it is in view, never over the page the use was on', async () => {
    const stop = watchPageUse(document);
    let failBlog;
    let usedPageInViewAtReload = null;
    reload.mockImplementation(() => { usedPageInViewAtReload = screen.queryByText('/admin/dashboard') !== null; });
    try {
      const move = renderGate(['/admin/dashboard'], {
        transitions: true,
        pages: { '/admin/blog': lazyWithRetry(() => new Promise((_, reject) => { failBlog = reject; })) },
      });
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
      move('/admin/blog');
      fireEvent.input(document.body);
      expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
      await act(async () => { failBlog(new TypeError('Failed to fetch dynamically imported module: /assets/Blog-old.js')); });
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(usedPageInViewAtReload).toBe(false);
    } finally {
      stop();
    }
  });

  // Back changes the address before the routes render. For that moment a
  // reload would close the staff page in view and open a customer page.
  test('while the address already names a customer page, the staff page in view keeps its rules: held work keeps the tab, and missing page code gets the staff retry screen, which names the work first', async () => {
    renderGate(['/admin/dashboard']);
    vi.stubGlobal('location', { ...window.location, pathname: '/', reload });
    holding = true;
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    renderInBoundary(lazyWithRetry(missingChunk));
    renderInBoundary(lazy(missingChunk));
    // The staff retry screen, not the customer one, whose Try Again reloads
    // at once: its Retry names the held work first. The two pages decide
    // apart, and findAll resolves on the first, so wait for both.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2));
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    tap(retries[0]);
    expect(screen.getByText('A card payment is still going through.')).toBeInTheDocument();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    expect(document.getElementById('chunk-reload-toast')).toBeNull();
    expect(reported.calls).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a move from a customer page gets the staff rules once the address names a staff page: the preload error leaves the import to fail, and held work keeps the tab', async () => {
    renderGate(['/']);
    holding = true;
    const stale = preloadErrorEvent();
    handleVitePreloadError(stale, reload);
    expect(stale.defaultPrevented).toBe(false);
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('card-payment');
    expect(reload).not.toHaveBeenCalled();
  });

  test('a move to a field page bars the reload before that page is in view', async () => {
    renderGate(['/admin/dashboard']);
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/today', reload });
    await expect(reloadForMissingCode({ pathname: '/admin/today', reload })).resolves.toBe('manual');
    expect(reload).not.toHaveBeenCalled();
  });

  test('a move that never comes into view keeps the bar on a page a move from a field page opened', async () => {
    const move = renderGate(['/admin/today'], { transitions: true });
    move('/admin/dashboard');
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    move('/admin/blog');
    move(-1);
    expect(screen.getByText('/admin/dashboard')).toBeInTheDocument();
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('manual');
    expect(reload).not.toHaveBeenCalled();
  });

  test('a move from a field page bars the reload: the next page\'s missing code gets the retry screen once that page is in view, and the one-shot flag stays clear', async () => {
    nameNewerBuild();
    const move = renderGate(['/admin/today'], { transitions: true, pages: { '/admin/blog': lazyWithRetry(missingChunk) } });
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
    move('/admin/blog');
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(screen.queryByText('/admin/today')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('in Waves Admin a page whose code is missing never reloads by itself: it gets the retry screen, and the one-shot flag stays clear', async () => {
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
    try {
      renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByText('Couldn’t load this page')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    } finally {
      delete window.webkit;
    }
  });

  test('offline, a page whose code is missing asks to check the connection, even with a newer build named, and its Retry names the offline device', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    nameNewerBuild();
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('This device is offline. A reload may show an error page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload anyway' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page used since it opened keeps the tab, so its missing code asks first; at the next page, a page whose code is missing reloads at once', async () => {
    const stop = watchPageUse(document);
    try {
      fireEvent.input(document.body);
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('page-use');
      expect(reload).not.toHaveBeenCalled();
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
      await expect(reloadForMissingCode({ pathname: '/admin/blog', reload })).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  test('a tap on a Reload control is no use of the page, so a page whose code is missing still reloads at once', async () => {
    const stop = watchPageUse(document);
    const control = document.body.appendChild(document.createElement('button'));
    control.setAttribute('data-portal-reload-prompt', '');
    try {
      fireEvent.pointerDown(control);
      await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      control.remove();
    }
  });

  test('a use of the page after the retry screen named the work clears it, so its Reload asks again', async () => {
    holding = true;
    nameNewerBuild();
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

  // React Router decodes each segment before it matches: both addresses open
  // a staff page, the second one Today (routerPath, lib/adminBookmarkMeta.js).
  test('an encoded address is judged as the routes match it: an encoded staff page gets the staff rules, and an encoded field page never reloads by itself', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/%61dmin/dashboard', reload });
    const staff = preloadErrorEvent();
    handleVitePreloadError(staff, reload);
    expect(staff.defaultPrevented).toBe(false);
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/%74oday', reload });
    await expect(reloadForMissingCode({ pathname: '/admin/%74oday', reload })).resolves.toBe('manual');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('after the one reload, a /tech address, plain or encoded, gets the staff retry screen, not the customer one', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    for (const pathname of ['/tech/route', '/%74ech/route']) {
      vi.stubGlobal('location', { ...window.location, pathname, reload });
      const view = renderInBoundary(lazyWithRetry(missingChunk));
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
      view.unmount();
    }
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page whose code is missing follows the device: back online with a newer build named, its screen says new version; offline again, it asks to check the connection', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    nameNewerBuild();
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    onLine.mockReturnValue(true);
    fireEvent(window, new Event('online'));
    expect(screen.getByText('The portal has a new version.')).toBeInTheDocument();
    onLine.mockReturnValue(false);
    fireEvent(window, new Event('offline'));
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('a mixed-case staff URL gets the staff retry screen, which asks before it reloads', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/ADMIN/Dashboard', reload });
    holding = true;
    nameNewerBuild();
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

  // React.lazy keeps a page it loaded, so Back to it loads nothing that ends
  // the count of the one reload on the path it reopened (noteChunkLoaded). A
  // move in view away from that path ends it, or a later deploy's missing
  // chunk there would never reload.
  test('a move in view away from the path the one reload reopened ends that reload\'s count: back on that path, a later missing page reloads once more', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    notePageInView(null, '/admin/dashboard');
    noteChunkLoaded(); // its page loads
    // A page still missing under it: no second reload.
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('reloaded');
    // To the More page, in the entry bundle, then Back: no page loads.
    notePageInView('/admin/dashboard', '/admin/more');
    notePageInView('/admin/more', '/admin/dashboard');
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('when the page the one reload reopened still fails, a move in view away from it ends that reload\'s count, flag included: a missing page elsewhere reloads once more', async () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    notePageInView(null, '/admin/dashboard');
    // Its page still fails: no page loads, so nothing clears the flag.
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('reloaded');
    // To the More page, in the entry bundle: no page loads there either.
    notePageInView('/admin/dashboard', '/admin/more');
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/customers', reload });
    notePageInView('/admin/more', '/admin/customers');
    await expect(reloadForMissingCode({ pathname: '/admin/customers', reload })).resolves.toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a move in view away from that path while a reload is under way keeps the one-shot flag: it must reach the page load that reload opens', () => {
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    markStaleChunkReloadPending();
    notePageInView('/admin/dashboard', '/admin/more');
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  });

  test('a move in view to the path the one reload reopened, written another way, keeps that reload\'s count', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog/caf%C3%A9', reload });
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
    resetStaleChunkReloadForTests(); // the page load the one reload opened
    noteChunkLoaded();
    notePageInView(null, '/admin/blog/café');
    await expect(reloadForMissingCode({ pathname: '/admin/blog/café', reload })).resolves.toBe('reloaded');
    expect(reload).not.toHaveBeenCalled();
  });

  test('a page that closed during the wait does not reload', async () => {
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', current: () => false, reload })).resolves.toBe('moved');
    expect(reload).not.toHaveBeenCalled();
  });

  // Back can move the address on even before the page's effect starts, while
  // the routes still show the page whose code is missing.
  test('Back before a page whose code is missing starts: the routes show it, but the address names the next page, so it does not reload', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/customers', reload });
    const Blog = lazyWithRetry(missingChunk);
    render(
      <MemoryRouter initialEntries={['/admin/blog']}>
        <PageErrorBoundary>
          <Suspense fallback={<div>Suspended</div>}>
            <Routes>
              <Route path="/admin/blog" element={<Blog />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  // A link's path stays as written in the router, while the browser encodes
  // the address. Both name the same page, as the routes match a path.
  test('an address the browser encoded names the same page as its route, so a page whose code is missing still reloads once', async () => {
    vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog/caf%C3%A9', reload });
    const Post = lazyWithRetry(missingChunk);
    render(
      <MemoryRouter initialEntries={['/admin/blog/café']}>
        <PageErrorBoundary>
          <Suspense fallback={<div>Suspended</div>}>
            <Routes>
              <Route path="/admin/blog/:slug" element={<Post />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </MemoryRouter>,
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  });

  test('once the address names another page, the page whose code is missing does not wait for open work', async () => {
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      target.fetch('/api/admin/dashboard');
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 500); });
      await expect(Promise.race([reloadForMissingCode({ pathname: '/admin/blog', reload }), waited])).resolves.toBe('moved');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  // Back moves the address on at once, but the routes keep the page in view
  // until the next page's code loads. A reload then would open the next
  // page, not this one, and spend the one reload on it.
  test('Back while a page whose code is missing waits for open work: the address names the next page, so the wait ends with the retry screen and no reload', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/auth/me');
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/blog', reload });
      let navigate;
      function Navigator() {
        navigate = useNavigate();
        return null;
      }
      const Blog = lazyWithRetry(missingChunk);
      const Customers = lazy(() => new Promise(() => {}));
      render(
        <MemoryRouter initialEntries={['/admin/customers', '/admin/blog']} initialIndex={1} future={{ v7_startTransition: true }}>
          <PortalUpdateGate fallback={<div>Gate placeholder</div>}>
            <Navigator />
            <Suspense fallback={<div>Loading the page</div>}>
              <Routes>
                <Route path="/admin/blog" element={<Blog />} />
                <Route path="/admin/customers" element={<Customers />} />
              </Routes>
            </Suspense>
          </PortalUpdateGate>
        </MemoryRouter>,
      );
      expect(await screen.findByText('Loading...')).toBeInTheDocument();
      // Back: the address names Customers at once; Blog stays in view while
      // the Customers page's code loads.
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/customers', reload });
      act(() => { navigate(-1); });
      expect(screen.getByText('Loading...')).toBeInTheDocument();
      pending[0]({ headers: new Headers() });
      await read;
      expect(await screen.findByText('Check your connection and try again.')).toBeInTheDocument();
      expect(reload).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    } finally {
      uninstall();
    }
  });

  test('a request the move already waited out is not waited for again: the page whose code is missing names it at once', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/dashboard');
      // #8121's wait at the move runs out on this request (lib/portalReload.js).
      let t = 0;
      await expect(reloadForNewBuild({ reload, now: () => (t += 20000) })).resolves.toBe('request');
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 500); });
      await expect(Promise.race([reloadForMissingCode({ pathname: '/admin/dashboard', reload }), waited])).resolves.toBe('request');
      expect(reload).not.toHaveBeenCalled();
      // The stalled state ends once no work is open, so later tests start
      // clean.
      pending[0]({ headers: new Headers() });
      await read;
      await waitForWork();
    } finally {
      uninstall();
    }
  });

  test('offline, a page whose code is missing does not wait for a request still open: an offline tab cannot reload by itself, so its retry screen comes at once', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/dashboard');
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 500); });
      await expect(Promise.race([reloadForMissingCode({ pathname: '/admin/dashboard', reload }), waited])).resolves.toBe('request');
      expect(reload).not.toHaveBeenCalled();
      pending[0]({ headers: new Headers() });
      await read;
    } finally {
      uninstall();
    }
  });

  test('held work rules the reload out before the wait, as at a page move: with a request still open, a page whose code is missing names it at once', async () => {
    holding = true;
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/dashboard');
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 500); });
      await expect(Promise.race([reloadForMissingCode({ pathname: '/admin/dashboard', reload }), waited])).resolves.toBe('request');
      expect(reload).not.toHaveBeenCalled();
      pending[0]({ headers: new Headers() });
      await read;
    } finally {
      uninstall();
    }
  });

  // The wait ends at its next look once no reload can follow, as it never
  // starts then (above): the screen comes at once, not after 10 s.
  test.each([
    ['held work', () => { holding = true; }],
    ['the browser going offline', () => { vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); }],
    ['a use of the page', () => { fireEvent.input(document.body); }],
  ])('%s during the wait for open work ends the wait: a page whose code is missing names the open work at once', async (_, start) => {
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    const stop = watchPageUse(document);
    try {
      target.fetch('/api/admin/dashboard');
      const result = reloadForMissingCode({ pathname: '/admin/dashboard', reload });
      await new Promise((resolve) => { setTimeout(resolve, 300); }); // the wait is under way
      start();
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 1000); });
      await expect(Promise.race([result, waited])).resolves.toBe('request');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      stop();
      uninstall();
    }
  });

  test('a move of the address during the wait for open work ends the wait, with no reload', async () => {
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      target.fetch('/api/admin/dashboard');
      const result = reloadForMissingCode({ pathname: '/admin/dashboard', reload });
      await new Promise((resolve) => { setTimeout(resolve, 300); }); // the wait is under way
      vi.stubGlobal('location', { ...window.location, pathname: '/admin/customers', reload });
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 1000); });
      await expect(Promise.race([result, waited])).resolves.toBe('moved');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  // A wait that ended early is not a full wait: the work has not outlasted
  // one, so a later wait still waits for it (waitForWork, lib/portalReload.js).
  test('after held work ends the wait early, the open request does not count as stalled: a later wait still waits for it', async () => {
    const pending = [];
    const target = { fetch: () => new Promise((resolve) => pending.push(resolve)) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      const read = target.fetch('/api/admin/dashboard');
      const result = reloadForMissingCode({ pathname: '/admin/dashboard', reload });
      await new Promise((resolve) => { setTimeout(resolve, 300); }); // the wait is under way
      holding = true;
      await expect(result).resolves.toBe('request');
      let settled = false;
      const again = waitForWork().then(() => { settled = true; });
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      expect(settled).toBe(false);
      pending[0]({ headers: new Headers() });
      await read;
      await again;
      expect(settled).toBe(true);
    } finally {
      uninstall();
    }
  });

  test('held work that starts as the wait for open work ends keeps the tab: the holds are read in the same turn as the reload', async () => {
    // Queued first, so it runs after the wait's last look at open work and
    // before the page goes on.
    queueMicrotask(() => { holding = true; });
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('card-payment');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  test('without session storage there is no one-shot guard, so the tab never reloads by itself; no reload ran, so its screen can say new version', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    await expect(reloadForMissingCode({ pathname: '/admin/dashboard', reload })).resolves.toBe('storage');
    nameNewerBuild();
    renderInBoundary(lazyWithRetry(missingChunk));
    expect(await screen.findByText('The portal has a new version.')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  test('without session storage no reload can follow, so it does not wait for open work: it names that work at once', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    const target = { fetch: () => new Promise(() => {}) };
    const uninstall = installPortalVersionWatch({ target });
    try {
      target.fetch('/api/admin/dashboard');
      const waited = new Promise((resolve) => { setTimeout(() => resolve('waited'), 500); });
      await expect(Promise.race([reloadForMissingCode({ pathname: '/admin/dashboard', reload }), waited])).resolves.toBe('request');
      expect(reload).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});
