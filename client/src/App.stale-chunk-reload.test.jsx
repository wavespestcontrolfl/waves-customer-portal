// @vitest-environment jsdom
import React, { Suspense, lazy } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  isStaleChunkReloadPending,
  markPageNavigating,
  resetStaleChunkReloadForTests,
} from './lib/staleChunkReload';
import { registerReloadHold } from './lib/reloadHolds';

// Work a reload would lose (lib/reloadHolds.js) keeps a staff tab here too.
let holding = false;
registerReloadHold('test-hold', () => holding);

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
  sessionStorage.clear();
  resetStaleChunkReloadForTests();
  holding = false;
  reported.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.pushState({}, '', '/');
  document.getElementById('chunk-reload-toast')?.remove();
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

test('held work on a staff page keeps the tab: the preload error neither reloads nor swallows the import', () => {
  window.history.pushState({}, '', '/admin/communications');
  holding = true;
  const reload = vi.fn();
  const event = preloadErrorEvent();
  handleVitePreloadError(event, reload);
  expect(event.defaultPrevented).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  expect(isStaleChunkReloadPending()).toBe(false);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
});

test.each([
  ['code', 'Failed to fetch dynamically imported module: /assets/Gone-abc123.js'],
  ['code (Firefox)', 'error loading dynamically imported module: /assets/Gone-abc123.js'],
  ['stylesheet', 'Unable to preload CSS for /assets/Gone-abc123.css'],
])('held work on a staff page gets the retry screen for a page whose %s is gone, with no reload', async (_part, message) => {
  window.history.pushState({}, '', '/admin/communications');
  holding = true;
  const GonePage = lazyWithRetry(() => Promise.reject(new Error(message)));
  renderInBoundary(GonePage);
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(reported.calls).toHaveLength(0);
  expect(isStaleChunkReloadPending()).toBe(false);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
});

test('held work on a staff page: a nested chunk that plain React.lazy loads gets the retry screen, not the crash screen', async () => {
  window.history.pushState({}, '', '/admin/dispatch');
  holding = true;
  const NestedGone = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/DispatchPageV2-abc123.js')));
  renderInBoundary(NestedGone);
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(reported.calls).toHaveLength(0);
});

test.each(['/admin/communications', '/ADMIN/Communications'])('the held retry screen on %s names the held work before it reloads', async (path) => {
  window.history.pushState({}, '', path);
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  holding = true;
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  const GonePage = lazyWithRetry(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Gone-abc123.js')));
  renderInBoundary(GonePage);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByText('Something in this tab is still open.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
});

test('the held retry screen still reloads when session storage is blocked', async () => {
  window.history.pushState({}, '', '/admin/communications');
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  holding = true;
  const GonePage = lazyWithRetry(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Gone-abc123.js')));
  renderInBoundary(GonePage);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  const blocked = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    blocked.mockRestore();
  }
});

test('an offline staff tab keeps its page: no reload for a missing chunk, and Retry names the offline state before it reloads', async () => {
  window.history.pushState({}, '', '/admin/today');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const reload = vi.fn();
  const event = preloadErrorEvent();
  handleVitePreloadError(event, reload);
  expect(reload).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  const pageReload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload: pageReload });
  const Panel = lazyWithRetry(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Panel-abc123.js')));
  renderInBoundary(Panel);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(pageReload).not.toHaveBeenCalled();
  expect(screen.getByText('This device is offline. A reload may show an error page.')).toBeInTheDocument();
  expect(isStaleChunkReloadPending()).toBe(false);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reload anyway' }));
  expect(pageReload).toHaveBeenCalledTimes(1);
});

test('a staff page with nothing held reloads at once for a missing chunk, with no delay in which work could start', async () => {
  window.history.pushState({}, '', '/admin/communications');
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  const GonePage = lazyWithRetry(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Gone-abc123.js')));
  renderInBoundary(GonePage);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  expect(document.getElementById('chunk-reload-toast')).toBeNull();
  expect(isStaleChunkReloadPending()).toBe(true);
});

test('a customer page still shows the toast for a missing chunk, then reloads 1.2 s later', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  const GonePage = lazyWithRetry(() => Promise.reject(new Error('Failed to fetch dynamically imported module: /assets/Gone-abc123.js')));
  renderInBoundary(GonePage);
  await vi.waitFor(() => expect(document.getElementById('chunk-reload-toast')).not.toBeNull());
  expect(reload).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
});

test('on a customer page, held work leaves the stale-chunk reload as it was', () => {
  holding = true;
  const reload = vi.fn();
  handleVitePreloadError(preloadErrorEvent(), reload);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('with no reload pending, a lazy page that loads normally clears the one-shot flag', async () => {
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  const Page = lazyWithRetry(() => Promise.resolve({ default: () => <div>Loaded page</div> }));
  renderInBoundary(Page);
  expect(await screen.findByText('Loaded page')).toBeInTheDocument();
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
});
