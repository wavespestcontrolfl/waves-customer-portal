// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => vi.fn());
const flushPending = vi.hoisted(() => vi.fn());
vi.mock('../lib/portalActivity', () => ({ reportPortalPageView: report, flushPendingPushOpen: flushPending }));

import usePortalActivity from './usePortalActivity';

beforeEach(() => {
  report.mockReset();
  flushPending.mockReset();
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('reports a tab only after the customer stays on it, debounced', () => {
  const { rerender } = renderHook(({ tab }) => usePortalActivity(tab), { initialProps: { tab: 'dashboard' } });
  vi.advanceTimersByTime(300);
  rerender({ tab: 'visits' });
  vi.advanceTimersByTime(300);
  rerender({ tab: 'billing' });
  expect(report).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith('billing');
});

it('does not report while the page is hidden or after unmount', () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  renderHook(() => usePortalActivity('plan'));
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const { unmount } = renderHook(() => usePortalActivity('learn'));
  unmount();
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();
});

it('defers a view scheduled while hidden to the next visible, and sends it once', () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  renderHook(() => usePortalActivity('plan'));
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();

  document.dispatchEvent(new Event('visibilitychange')); // still hidden
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('visibilitychange')); // a duplicate event inside the debounce sends once
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledWith('plan');
});

it('re-reports the current tab every time the app returns to the foreground', () => {
  renderHook(() => usePortalActivity('visits'));
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(2000);
  expect(report).toHaveBeenCalledTimes(1);

  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith('visits');
});

it('goes hidden during the debounce: nothing is sent until it is visible again', () => {
  renderHook(() => usePortalActivity('learn'));
  vi.advanceTimersByTime(300);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(1);
});

it('drops a deferred view when the customer leaves the tab or unmounts before it shows', () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const { rerender, unmount } = renderHook(({ tab }) => usePortalActivity(tab), { initialProps: { tab: 'plan' } });
  vi.advanceTimersByTime(2000);
  rerender({ tab: 'billing' });
  vi.advanceTimersByTime(2000);
  unmount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(report).not.toHaveBeenCalled();
});

it('does nothing without a route', () => {
  renderHook(() => usePortalActivity(null));
  vi.advanceTimersByTime(2000);
  expect(report).not.toHaveBeenCalled();
});

it('retries a push open that never got an answer, once per mount', () => {
  const { rerender } = renderHook(({ tab }) => usePortalActivity(tab), { initialProps: { tab: 'dashboard' } });
  rerender({ tab: 'visits' });
  expect(flushPending).toHaveBeenCalledTimes(1);
});
