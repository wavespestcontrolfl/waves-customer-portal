// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchAlerts, mergeHydration, RESYNC_DEBOUNCE_MS } from './useDispatchAlerts';

const socketHandlers = vi.hoisted(() => ({}));
const socketOff = vi.hoisted(() => vi.fn());
const socketDisconnect = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn((event, handler) => { socketHandlers[event] = handler; }),
    off: vi.fn((event, handler) => { socketOff(event, handler); delete socketHandlers[event]; }),
    disconnect: socketDisconnect,
  })),
}));

const ok = (alerts) => ({ ok: true, json: async () => ({ alerts }) });
const row = (id, createdAt, extra = {}) => ({
  id, type: 'tech_out_overflow', tech_id: 't1', created_at: createdAt, payload: {}, ...extra,
});
const A = row('a', '2026-11-05T10:00:00Z', { tech_name: 'Tech A' });
const B = row('b', '2026-11-05T11:00:00Z', { tech_name: 'Tech B' });
const C = row('c', '2026-11-05T12:00:00Z', { tech_name: 'Tech C' });

// A deferred fetch response the test resolves by hand.
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let server;
beforeEach(() => {
  server = [A, B];
  vi.stubGlobal('fetch', vi.fn(async () => ok(structuredClone(server))));
  localStorage.setItem('waves_admin_token', 'test-token');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  socketOff.mockClear();
  socketDisconnect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
  vi.unstubAllGlobals();
  localStorage.clear();
});

const ids = (hook) => hook.result.current.alerts.map((a) => a.id);

async function mounted() {
  const hook = renderHook(() => useDispatchAlerts());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(ids(hook)).toEqual(['b', 'a']);
  expect(fetch).toHaveBeenCalledTimes(1);
  return hook;
}

async function settleDebounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS + 50); });
}

// Mount read done, fake timers on, fetch counter reset.
async function loaded() {
  const hook = await mounted();
  vi.useFakeTimers();
  fetch.mockClear();
  return hook;
}

describe('recovery re-read triggers', () => {
  it.each([
    ['socket connect', () => socketHandlers.connect()],
    ['window focus', () => window.dispatchEvent(new Event('focus'))],
    ['window online', () => window.dispatchEvent(new Event('online'))],
    ['visible visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
  ])('%s re-reads the queue once, after the debounce', async (_name, fire) => {
    await loaded();
    act(() => { fire(); });
    expect(fetch).not.toHaveBeenCalled();
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('/admin/dispatch/alerts?unresolved=true');
  });

  it('a hidden visibilitychange does not re-read', async () => {
    await loaded();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settleDebounce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a burst of signals collapses into one read', async () => {
    await loaded();
    act(() => {
      socketHandlers.connect();
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a signal during a running re-read queues exactly one more', async () => {
    const hook = await loaded();
    const first = deferred();
    fetch.mockImplementationOnce(() => first.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event('online')); });
    await settleDebounce();
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1); // still the one in flight
    await act(async () => { first.resolve(ok([A, B])); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ids(hook)).toEqual(['b', 'a']);
  });

  it('a background re-read does not flash the loading state', async () => {
    const hook = await loaded();
    const slow = deferred();
    fetch.mockImplementationOnce(() => slow.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(hook.result.current.loading).toBe(false);
    await act(async () => { slow.resolve(ok([A, B])); });
    expect(hook.result.current.loading).toBe(false);
  });
});

describe('a re-read reconciles', () => {
  it('drops a card the server no longer lists and shows a new server card', async () => {
    const hook = await loaded();
    server = [C, B]; // a closed elsewhere, c opened during a socket gap
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(ids(hook)).toEqual(['c', 'b']);
    expect(hook.result.current.alerts[0].tech_name).toBe('Tech C');
  });

  it('keeps a card broadcast while the read was in flight and absent from its response', async () => {
    const hook = await loaded();
    const slow = deferred();
    fetch.mockImplementationOnce(() => slow.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    await act(async () => { socketHandlers['dispatch:alert'](C); });
    expect(ids(hook)).toEqual(['c', 'b', 'a']);
    await act(async () => { slow.resolve(ok([A, B])); }); // read predates c
    expect(ids(hook)).toEqual(['c', 'b', 'a']);
  });

  it('a card updated by broadcast during the read keeps its live payload over the fetched row', async () => {
    const hook = await loaded();
    const slow = deferred();
    fetch.mockImplementationOnce(() => slow.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    await act(async () => { socketHandlers['dispatch:alert']({ ...A, payload: { auto_attempt: { reason: 'window_occupied' } } }); });
    await act(async () => { slow.resolve(ok([A, B])); });
    const a = hook.result.current.alerts.find((x) => x.id === 'a');
    expect(a.payload.auto_attempt.reason).toBe('window_occupied');
    expect(a.tech_name).toBe('Tech A');
  });

  it('the server\'s fields win for a card not changed since the read began', async () => {
    const hook = await loaded();
    await act(async () => { socketHandlers['dispatch:alert']({ ...A, payload: { stale: true } }); });
    server = [{ ...A, payload: { fresh: true } }, B];
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(hook.result.current.alerts.find((x) => x.id === 'a').payload).toEqual({ fresh: true });
  });

  it('an older read returning after a newer one does not roll the list back', async () => {
    const hook = await loaded();
    const older = deferred();
    fetch.mockImplementationOnce(() => older.promise);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    // Retry uses its own read while the re-read is still pending.
    server = [C];
    await act(async () => { await hook.result.current.retryAlerts(); });
    expect(ids(hook)).toEqual(['c']);
    await act(async () => { older.resolve(ok([A, B])); }); // started first, returns last
    expect(ids(hook)).toEqual(['c']);
  });

  it('a tombstoned card is not resurrected by a re-read that still lists it', async () => {
    const hook = await loaded();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'a' }) });
    await act(async () => { await hook.result.current.resolveAlert('a'); });
    expect(ids(hook)).toEqual(['b']);
    server = [A, B]; // a stale read still lists it
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(ids(hook)).toEqual(['b']);
  });
});

describe('failures', () => {
  it('a failed background re-read keeps the list and shows no error', async () => {
    const hook = await loaded();
    fetch.mockRejectedValueOnce(new Error('network down'));
    act(() => { window.dispatchEvent(new Event('online')); });
    await settleDebounce();
    expect(ids(hook)).toEqual(['b', 'a']);
    expect(hook.result.current.error).toBeNull();
    // The next trigger retries.
    server = [C];
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(ids(hook)).toEqual(['c']);
  });

  it('a successful re-read clears the error of a failed load', async () => {
    fetch.mockRejectedValueOnce(new Error('boom'));
    const hook = renderHook(() => useDispatchAlerts());
    await waitFor(() => expect(hook.result.current.error).toBe('boom'));
    vi.useFakeTimers();
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(hook.result.current.error).toBeNull();
    expect(ids(hook)).toEqual(['b', 'a']);
  });

  it('a failed load never puts its error over a list a newer read already loaded', async () => {
    const slowFail = deferred();
    fetch.mockImplementationOnce(() => slowFail.promise); // the mount read
    const hook = renderHook(() => useDispatchAlerts());
    vi.useFakeTimers();
    act(() => { socketHandlers.connect(); });
    await settleDebounce(); // the newer read loads the list
    expect(ids(hook)).toEqual(['b', 'a']);
    await act(async () => { slowFail.reject(new Error('late failure')); });
    expect(hook.result.current.error).toBeNull();
    expect(ids(hook)).toEqual(['b', 'a']);
  });
});

describe('cleanup', () => {
  it('removes the socket handlers, window listeners and the timer on unmount', async () => {
    const removeWin = vi.spyOn(window, 'removeEventListener');
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const hook = await loaded();
    act(() => { window.dispatchEvent(new Event('focus')); }); // timer pending
    hook.unmount();
    expect(socketOff.mock.calls.map((c) => c[0]).sort()).toEqual(['connect', 'dispatch:alert', 'dispatch:alert_resolved']);
    expect(socketDisconnect).toHaveBeenCalled();
    expect(removeWin.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['focus', 'online']));
    expect(removeDoc.mock.calls.map((c) => c[0])).toContain('visibilitychange');
    fetch.mockClear();
    await settleDebounce();
    expect(fetch).not.toHaveBeenCalled();
    removeWin.mockRestore();
    removeDoc.mockRestore();
  });
});

describe('mergeHydration changedSinceRead predicate', () => {
  const prev = [A, B];
  it('drops local cards not changed since the read and absent from the fetch', () => {
    expect(mergeHydration(prev, [C], null, () => false).map((a) => a.id)).toEqual(['c']);
  });
  it('keeps a local card flagged changed even when the fetch lacks it', () => {
    expect(mergeHydration(prev, [C], null, (id) => id === 'a').map((a) => a.id)).toEqual(['c', 'a']);
  });
  it('takes the server fields for an unchanged card, layers live fields for a changed one', () => {
    const live = [{ ...A, payload: { live: true } }, { ...B, payload: { live: true } }];
    const fetched = [{ ...A, payload: { fresh: true } }, { ...B, payload: { fresh: true } }];
    const out = mergeHydration(live, fetched, null, (id) => id === 'a');
    expect(out.find((x) => x.id === 'a').payload).toEqual({ live: true });
    expect(out.find((x) => x.id === 'b').payload).toEqual({ fresh: true });
  });
  it('tombstones win over a fetched row, whether or not the local card changed', () => {
    const out = mergeHydration([B], [A, C], new Set(['a', 'c']), () => false);
    expect(out.map((x) => x.id)).toEqual([]);
    expect(mergeHydration([B], [A, C], new Set(['a']), () => true).map((x) => x.id)).toEqual(['c', 'b']);
  });
});
