// @vitest-environment jsdom
import React, { Suspense, lazy } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const reported = vi.hoisted(() => ({ calls: [] }));
vi.mock('./lib/reportError', () => ({ reportError: (...args) => { reported.calls.push(args); } }));
vi.mock('./hooks/useAuth', () => ({ AuthProvider: ({ children }) => children, useAuth: () => null }));
vi.mock('./components/BiometricGate', () => ({ default: ({ children }) => children, useBiometricLock: () => false }));
vi.mock('./components/InstallPrompt', () => ({ default: () => null }));
vi.mock('./components/analytics/PublicFunnelTracking', () => ({ default: () => null }));
vi.mock('./glass/glass-engine', () => ({ useGlassSurface: () => {} }));
import { PageErrorBoundary, lazyWithRetry } from './App';
import {
  CHUNK_RELOAD_FLAG,
  handleVitePreloadError,
  isChunkError,
  isStaleChunkReloadPending,
  markPageNavigating,
  reloadForMissingCode,
  resetStaleChunkReloadForTests,
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

test('a customer page keeps its stale-chunk reload while a staff tab hold is open', () => {
  holding = true;
  const reload = vi.fn();
  const stale = preloadErrorEvent();
  handleVitePreloadError(stale, reload);
  expect(stale.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
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
