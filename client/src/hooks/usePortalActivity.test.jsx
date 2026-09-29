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
