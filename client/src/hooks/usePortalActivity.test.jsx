// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => vi.fn());
const heartbeat = vi.hoisted(() => vi.fn());
vi.mock('../lib/portalActivity', () => ({ reportPortalPageView: report, reportPortalHeartbeat: heartbeat }));

import usePortalActivity from './usePortalActivity';

beforeEach(() => {
  report.mockReset();
  heartbeat.mockReset();
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

it('a profile switch on the same tab re-reports that tab once; the same identity does not', () => {
  const { rerender } = renderHook(({ tab, who }) => usePortalActivity(tab, who), { initialProps: { tab: 'visits', who: 'cust-a:1' } });
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(1);
  rerender({ tab: 'visits', who: 'cust-a:1' }); // nothing changed
  vi.advanceTimersByTime(2000);
  expect(report).toHaveBeenCalledTimes(1);
  rerender({ tab: 'visits', who: 'cust-b:2' }); // profile switch, same tab
  vi.advanceTimersByTime(300);
  expect(report).toHaveBeenCalledTimes(1); // debounced like any view
  vi.advanceTimersByTime(1000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith('visits');
  vi.advanceTimersByTime(5000);
  expect(report).toHaveBeenCalledTimes(2);
});

it('a profile switch does not restart the heartbeat timer', () => {
  const { rerender } = renderHook(({ who }) => usePortalActivity('visits', who), { initialProps: { who: 'cust-a:1' } });
  vi.advanceTimersByTime(30 * 1000);
  rerender({ who: 'cust-b:2' });
  vi.advanceTimersByTime(31 * 1000); // 61s since mount: the original interval fires once
  expect(heartbeat).toHaveBeenCalledTimes(1);
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

const MIN = 60 * 1000;

it('heartbeats while visible and the customer has interacted within five minutes', () => {
  renderHook(() => usePortalActivity('visits'));
  vi.advanceTimersByTime(2 * MIN);
  expect(heartbeat).toHaveBeenCalled(); // mount counts as the first interaction
  heartbeat.mockClear();
  vi.advanceTimersByTime(4 * MIN); // idle since mount: 6 minutes in, past the window
  window.dispatchEvent(new Event('pointerdown'));
  vi.advanceTimersByTime(MIN);
  expect(heartbeat).toHaveBeenCalled();
});

it('sends no heartbeat when idle for more than five minutes', () => {
  renderHook(() => usePortalActivity('visits'));
  vi.advanceTimersByTime(5 * MIN + 1000);
  heartbeat.mockClear();
  vi.advanceTimersByTime(10 * MIN);
  expect(heartbeat).not.toHaveBeenCalled();
});

it.each(['keydown', 'scroll', 'touchstart'])('a %s keeps the session active', (name) => {
  renderHook(() => usePortalActivity('visits'));
  vi.advanceTimersByTime(5 * MIN + 1000);
  heartbeat.mockClear();
  window.dispatchEvent(new Event(name));
  vi.advanceTimersByTime(MIN);
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it('sends no heartbeat while the page is hidden, even with recent interaction', () => {
  renderHook(() => usePortalActivity('visits'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  window.dispatchEvent(new Event('pointerdown'));
  vi.advanceTimersByTime(3 * MIN);
  expect(heartbeat).not.toHaveBeenCalled();
});

it('stops the heartbeat on unmount', () => {
  const { unmount } = renderHook(() => usePortalActivity('visits'));
  unmount();
  vi.advanceTimersByTime(10 * MIN);
  expect(heartbeat).not.toHaveBeenCalled();
});
