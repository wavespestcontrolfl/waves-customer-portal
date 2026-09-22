// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useDashboardData from './useDashboardData';
import { adminFetch } from '../../../utils/admin-fetch';

vi.mock('../../../utils/admin-fetch', () => ({ adminFetch: vi.fn() }));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = (path) => {
  if (path.endsWith('/alerts')) return { alerts: [] };
  if (path.endsWith('/stale-visits')) return { visits: [] };
  if (path.endsWith('/today-completion')) return { total: 2, completed: 1 };
  return { path };
};
const settle = async () => { await act(async () => {}); };

beforeEach(() => {
  adminFetch.mockImplementation(async (path) => response(path));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('dashboard request recovery', () => {
  it('publishes overdue visits and completion while analytics is stalled', async () => {
    const stalled = deferred();
    adminFetch.mockImplementation((path) => path.endsWith('/funnel') ? stalled.promise : Promise.resolve(response(path)));
    const { result } = renderHook(() => useDashboardData('all', 'period=mtd'));
    await waitFor(() => expect(result.current.values.staleVisits).toEqual({ visits: [] }));
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith('/admin/dashboard/funnel', expect.anything()));
    expect(result.current.values.today.completed).toBe(1);
    expect(result.current.pending.funnel).toBe(true);
    expect(result.current.pending.staleVisits).toBe(false);
  });

  it('loads only Today and shared metrics until another mobile tab is opened', async () => {
    const { result, rerender } = renderHook(({ tab }) => useDashboardData(tab, 'period=mtd'), { initialProps: { tab: 'today' } });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    const paths = adminFetch.mock.calls.map(([path]) => path);
    expect(paths).toHaveLength(6);
    expect(paths).not.toContain('/admin/dashboard/funnel');
    expect(paths).not.toContain('/admin/dashboard/ebitda-bridge');
    rerender({ tab: 'profit' });
    await waitFor(() => expect(result.current.values.ebitda).toBeTruthy());
    expect(adminFetch.mock.calls.some(([path]) => path.includes('/calls-by-source'))).toBe(false);
    expect(result.current.values.staleVisits).toBeUndefined();
  });

  it('limits simultaneous requests to four and aborts them on unmount', async () => {
    const stalled = deferred();
    adminFetch.mockReturnValue(stalled.promise);
    const { unmount } = renderHook(() => useDashboardData('all', 'period=mtd'));
    expect(adminFetch).toHaveBeenCalledTimes(4);
    expect(adminFetch.mock.calls.slice(0, 3).map(([path]) => path)).toEqual([
      '/admin/dashboard/alerts', '/admin/dashboard/today-completion', '/admin/command-center/stale-visits',
    ]);
    const signals = adminFetch.mock.calls.map(([, options]) => options.signal);
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await settle();
    expect(adminFetch).toHaveBeenCalledTimes(4);
  });

  it('times out an unresponsive request and allows a successful retry', async () => {
    vi.useFakeTimers();
    const stalled = deferred();
    adminFetch.mockImplementation((path) => path.endsWith('/stale-visits') ? stalled.promise : Promise.resolve(response(path)));
    const { result } = renderHook(() => useDashboardData('today', 'period=mtd'));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(result.current.errors.staleVisits.message).toMatch(/timed out/);
    expect(result.current.refreshing).toBe(false);
    adminFetch.mockImplementation(async (path) => response(path));
    await act(async () => result.current.refresh());
    expect(result.current.errors.staleVisits).toBeNull();
    expect(result.current.values.staleVisits).toEqual({ visits: [] });
    expect(result.current.lastUpdated).not.toBeNull();
    // A provider which ignores abort cannot overwrite the successful retry.
    await act(async () => stalled.resolve({ visits: [{ id: 'late' }] }));
    expect(result.current.values.staleVisits.visits).toEqual([]);
  });

  it('retains the previous empty backlog but marks it stale when refresh fails', async () => {
    const { result } = renderHook(() => useDashboardData('today', 'period=mtd'));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    adminFetch.mockImplementation(async (path) => {
      if (path.endsWith('/stale-visits')) throw new Error('Unavailable');
      return response(path);
    });
    await act(async () => result.current.refresh());
    expect(result.current.values.staleVisits).toEqual({ visits: [] });
    expect(result.current.errors.staleVisits.message).toBe('Unavailable');
    expect(result.current.pending.staleVisits).toBe(false);
  });

  it('refetches only period-driven feeds after a completed desktop cycle', async () => {
    const { result, rerender } = renderHook(({ period }) => useDashboardData('all', period), {
      initialProps: { period: 'period=mtd' },
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    const retainedAlerts = result.current.values.alerts;
    adminFetch.mockClear();

    rerender({ period: 'period=qtd' });

    expect(result.current.values.alerts).toBe(retainedAlerts);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(adminFetch.mock.calls.map(([path]) => path)).toEqual([
      '/admin/dashboard/core-kpis?period=qtd',
      '/admin/dashboard/calls-by-source?period=qtd',
      '/admin/dashboard/leads-by-source?period=qtd',
      '/admin/dashboard/channel-mix?period=qtd',
      '/admin/dashboard/lead-funnel?period=qtd',
      '/admin/dashboard/channel-roi?period=qtd',
    ]);
    expect(result.current.values.alerts).toBe(retainedAlerts);
    expect(result.current.values.kpis.path).toContain('period=qtd');
  });

  it('prioritizes the new period and requeues fixed feeds aborted mid-cycle', async () => {
    const oldCycle = deferred();
    const newCycle = deferred();
    let switched = false;
    adminFetch.mockImplementation((path) => {
      if (!switched) return oldCycle.promise;
      const changedPeriod = path.includes('period=qtd');
      const operational = path.endsWith('/alerts') || path.endsWith('/today-completion') || path.endsWith('/stale-visits');
      if (changedPeriod || operational) {
        return newCycle.promise.then(() => (changedPeriod ? { path: 'new-period' } : response(path)));
      }
      return Promise.resolve(response(path));
    });
    const { result, rerender } = renderHook(({ period }) => useDashboardData('all', period), {
      initialProps: { period: 'period=mtd' },
    });
    expect(adminFetch).toHaveBeenCalledTimes(4);
    const oldSignals = adminFetch.mock.calls.map(([, options]) => options.signal);

    switched = true;
    rerender({ period: 'period=qtd' });

    expect(oldSignals.every((signal) => signal.aborted)).toBe(true);
    expect(adminFetch).toHaveBeenCalledTimes(8);
    expect(adminFetch.mock.calls.slice(4).map(([path]) => path)).toEqual([
      '/admin/dashboard/alerts',
      '/admin/dashboard/today-completion',
      '/admin/command-center/stale-visits',
      '/admin/dashboard/core-kpis?period=qtd',
    ]);
    expect(result.current.pending.alerts).toBe(true);

    await act(async () => newCycle.resolve());
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(adminFetch).toHaveBeenCalledTimes(31);
    expect(adminFetch.mock.calls.slice(4, 13).map(([path]) => path)).toEqual([
      '/admin/dashboard/alerts',
      '/admin/dashboard/today-completion',
      '/admin/command-center/stale-visits',
      '/admin/dashboard/core-kpis?period=qtd',
      '/admin/dashboard/calls-by-source?period=qtd',
      '/admin/dashboard/leads-by-source?period=qtd',
      '/admin/dashboard/channel-mix?period=qtd',
      '/admin/dashboard/lead-funnel?period=qtd',
      '/admin/dashboard/channel-roi?period=qtd',
    ]);
    expect(result.current.values.kpis).toEqual({ path: 'new-period' });
    expect(result.current.values.alerts).toEqual({ alerts: [] });
    expect(result.current.pending.alerts).toBe(false);

    await act(async () => oldCycle.resolve({
      path: 'old-period', alerts: [{ id: 'late' }], visits: [{ id: 'late' }], total: 99,
    }));
    expect(result.current.values.kpis).toEqual({ path: 'new-period' });
    expect(result.current.values.alerts).toEqual({ alerts: [] });
  });

  it('does not show old-period KPIs or accept late results after a period switch', async () => {
    const oldPeriod = deferred();
    adminFetch.mockImplementation((path) => path.includes('core-kpis?period=mtd') ? oldPeriod.promise : Promise.resolve(response(path)));
    const { result, rerender } = renderHook(({ period }) => useDashboardData('today', period), { initialProps: { period: 'period=mtd' } });
    await settle();
    rerender({ period: 'period=qtd' });
    expect(result.current.values.kpis).toBeNull();
    await waitFor(() => expect(result.current.values.kpis?.path).toContain('period=qtd'));
    await act(async () => oldPeriod.resolve({ path: 'old-period' }));
    expect(result.current.values.kpis.path).toContain('period=qtd');
  });

  it('pauses polling in a hidden tab and refreshes on return', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDashboardData('today', 'period=mtd'));
    await settle();
    expect(result.current.refreshing).toBe(false);
    adminFetch.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(adminFetch).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(adminFetch).toHaveBeenCalledTimes(6);
  });

  it('treats malformed operational feeds as unavailable rather than empty', async () => {
    adminFetch.mockResolvedValue({});
    const { result } = renderHook(() => useDashboardData('today', 'period=mtd'));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.errors.alerts).toBeInstanceOf(Error);
    expect(result.current.errors.staleVisits).toBeInstanceOf(Error);
    expect(result.current.errors.today).toBeInstanceOf(Error);
    expect(result.current.lastUpdated).toBeNull();
  });
});
