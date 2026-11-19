// @vitest-environment jsdom
import React, { Suspense, lazy } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  isChunkLoadError,
  isStaleChunkReloadPending,
  markPageNavigating,
  preloadInBackground,
  resetStaleChunkReloadForTests,
} from './lib/staleChunkReload';

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

// What Vite 5.4's preload helper does when a chunk fails: it puts the error
// on a vite:preloadError event. When no handler called preventDefault(), the
// import rejects with that same error; otherwise it resolves undefined.
function failLikeVite(settle, err, reload) {
  const event = preloadErrorEvent();
  event.payload = err;
  handleVitePreloadError(event, reload);
  if (event.defaultPrevented) settle.resolve(undefined);
  else settle.reject(err);
  return event;
}

// A failure seen while a background preload runs is decided one task later.
function nextTask() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function pendingImport(imports) {
  return () => new Promise((resolve, reject) => { imports.push({ resolve, reject }); });
}

// Field view (pre-push P1, round 5): turning the switch on loads Today's code
// in the background. With no signal that load fails; the failure is not a
// stale page, so it must not reload over the Settings page.
test('a failed background preload never reloads, also for a loader that fails late', async () => {
  const reload = vi.fn();
  const imports = [];
  const preload = preloadInBackground([pendingImport(imports), pendingImport(imports)]);
  const early = failLikeVite(imports[0], new TypeError('Failed to fetch dynamically imported module: /assets/TodayShell-new.js'), reload);
  await nextTask();
  const late = failLikeVite(imports[1], new Error('Unable to preload CSS for /assets/TechHomePage-new.css'), reload);
  await expect(preload).resolves.toBe(false);
  await nextTask();
  expect([early.defaultPrevented, late.defaultPrevented]).toEqual([false, false]);
  expect(reload).not.toHaveBeenCalled();
  expect(isStaleChunkReloadPending()).toBe(false);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  // Once every loader settled, a failed chunk is a stale page again.
  const stale = preloadErrorEvent();
  handleVitePreloadError(stale, reload);
  expect(stale.defaultPrevented).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
});

// Pre-push P1 (round 6): only the preload's own failures skip the reload. A
// page opened while it runs keeps its recovery: CSS, JS or any other import.
test("a failure that is not the background preload's still reloads once, one task later", async () => {
  const reload = vi.fn();
  const imports = [];
  const preload = preloadInBackground([pendingImport(imports)]);
  const page = { resolve: vi.fn(), reject: vi.fn() };
  const event = failLikeVite(page, new Error('Unable to preload CSS for /assets/CustomersPageV2-old.css'), reload);
  expect(event.defaultPrevented).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  await nextTask();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(isStaleChunkReloadPending()).toBe(true);
  expect(sessionStorage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  imports[0].resolve({ default: () => null });
  await expect(preload).resolves.toBe(true);
});

test('a failure decided after an app link started navigating is held for it, not reloaded over it', () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  const windowReload = vi.fn();
  const imports = [];
  void preloadInBackground([pendingImport(imports)]);
  failLikeVite({ resolve: vi.fn(), reject: vi.fn() }, new Error('Unable to preload CSS for /assets/CustomersPageV2-old.css'), reload);
  markPageNavigating(windowReload);
  vi.advanceTimersByTime(0);
  expect(reload).not.toHaveBeenCalled();
  expect(isStaleChunkReloadPending()).toBe(true);
  // The navigation never committed: the window's end reloads, as for any held chunk.
  vi.advanceTimersByTime(30000);
  expect(windowReload).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

test('a background preload is ready only when every loader returned a module', async () => {
  const page = async () => ({ default: () => null });
  await expect(preloadInBackground([page, page])).resolves.toBe(true);
  // A chunk a navigation window held resolves undefined: nothing loaded.
  await expect(preloadInBackground([page, swallowedImport])).resolves.toBe(false);
  await expect(preloadInBackground([page, () => { throw new Error('sync failure'); }])).resolves.toBe(false);
});

test("Vite's CSS preload failure counts as a chunk that did not load, like the browsers' import failures", () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://portal.example/assets/Page-old.js',
    'Importing a module script failed.',
    'ChunkLoadError: Loading chunk 7 failed.',
    'Unable to preload CSS for /assets/Page-old.css',
  ]) expect(isChunkLoadError(new Error(message))).toBe(true);
  expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  expect(isChunkLoadError(undefined)).toBe(false);
});

// The page's CSS failure reaches lazyWithRetry whenever the handler did not
// hold it. After the one automatic reload it gets the retry screen, as a
// failed chunk does, not the crash screen.
test('after the one automatic reload, a page whose CSS still fails shows the retry screen, not the crash screen', async () => {
  sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
  const StalePage = lazyWithRetry(() => Promise.reject(new Error('Unable to preload CSS for /assets/Page-old.css')));
  renderInBoundary(StalePage);
  expect(await screen.findByText(/load this page/)).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  expect(reported.calls).toEqual([]);
});
