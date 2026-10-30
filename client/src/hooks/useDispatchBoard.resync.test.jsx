// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchBoard, RESYNC_DEBOUNCE_MS } from './useDispatchBoard';

const socketHandlers = vi.hoisted(() => ({}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn((event, handler) => { socketHandlers[event] = handler; }),
    off: vi.fn((event) => { delete socketHandlers[event]; }),
    disconnect: vi.fn(),
  })),
}));

function board(techId) {
  return {
    techs: [{ id: techId, name: techId, status: 'idle', out_today: false, updated_at: 't0' }],
    jobs: [{ id: 'job-1', technician_id: techId, status: 'confirmed', address: '123 Main St' }],
  };
}
const ok = (body) => ({ ok: true, json: async () => body });

let server;
beforeEach(() => {
  server = board('t1');
  vi.stubGlobal('fetch', vi.fn(async () => ok(structuredClone(server))));
  localStorage.setItem('waves_admin_token', 'test-token');
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function loaded() {
  const hook = renderHook(() => useDispatchBoard());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.jobs[0].technician_id).toBe('t1');
  expect(fetch).toHaveBeenCalledTimes(1);
  return hook;
}

async function settleDebounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS + 50); });
}

describe('board recovery after a missed broadcast', () => {
  it('re-reads once after the socket reconnects and shows the new assignment', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.disconnect('transport close'); });
    expect(result.current.boardStatus).toBe('reconnecting');
    server = board('t2'); // dispatch reassigned while this tab was offline
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.jobs[0].technician_id).toBe('t2');
    expect(result.current.boardStatus).toBe('live');
  });

  it('does not re-read on the first connect (mount hydration covers it)', async () => {
    await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-reads after a failed first connect once the socket comes up', async () => {
    await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.connect_error(new Error('xhr poll error')); });
    server = board('t2');
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('re-reads once on window focus', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    server = board('t2');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.jobs[0].technician_id).toBe('t2');
  });

  it('re-reads when the tab becomes visible, not when it is hidden', async () => {
    await loaded();
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('re-reads when the browser comes back online', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(result.current.boardStatus).toBe('stale');
    server = board('t2');
    act(() => { window.dispatchEvent(new Event('online')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.jobs[0].technician_id).toBe('t2');
    expect(result.current.boardStatus).toBe('live');
  });

  it('collapses reconnect + focus + visible + online into one re-read', async () => {
    await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.disconnect('transport close'); });
    act(() => {
      socketHandlers.connect();
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never overlaps resync reads: a signal during a read queues exactly one more', async () => {
    await loaded();
    vi.useFakeTimers();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fetch.mockImplementationOnce(async () => ({ ok: true, json: () => gate.then(() => board('t2')) }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2); // in flight
    act(() => { window.dispatchEvent(new Event('online')); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2); // still waiting on the first
    server = board('t3');
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(10); });
    expect(fetch).toHaveBeenCalledTimes(3); // one queued re-read, no more
  });

  it('keeps the old roster and the stale flag when the re-read fails, then clears on success', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.disconnect('transport close'); });
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    act(() => { socketHandlers.connect(); });
    await settleDebounce();
    expect(result.current.jobs[0].technician_id).toBe('t1');
    expect(result.current.error).toBeNull();
    expect(result.current.boardStatus).toBe('stale');
    server = board('t2');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(result.current.jobs[0].technician_id).toBe('t2');
    expect(result.current.boardStatus).toBe('live');
  });

  it('stops listening and cancels a pending re-read on unmount', async () => {
    const { unmount } = await loaded();
    vi.useFakeTimers();
    act(() => { window.dispatchEvent(new Event('focus')); });
    unmount();
    await settleDebounce();
    window.dispatchEvent(new Event('focus'));
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a focus read while the socket is down never clears the stale state; reconnect needs its own read', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    act(() => { socketHandlers.disconnect('transport close'); });
    server = board('t2');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.jobs[0].technician_id).toBe('t2'); // data applied
    expect(result.current.boardStatus).toBe('reconnecting'); // but not trusted

    // The socket comes back; the recovery read fails. Never report live.
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    act(() => { socketHandlers.connect(); });
    expect(result.current.boardStatus).toBe('stale');
    await settleDebounce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.current.boardStatus).toBe('stale');

    // A later successful read that started with the socket up clears it.
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce();
    expect(result.current.boardStatus).toBe('live');
  });

  it('a read that began before the reconnect does not clear the stale state when it lands after', async () => {
    const { result } = await loaded();
    vi.useFakeTimers();
    act(() => { window.dispatchEvent(new Event('offline')); });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fetch.mockImplementationOnce(async () => ({ ok: true, json: () => gate.then(() => board('t2')) }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settleDebounce(); // read started with the socket up
    act(() => { socketHandlers.disconnect('transport close'); });
    act(() => { socketHandlers.connect(); }); // reconnect while that read is in flight
    fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.boardStatus).toBe('stale');
    await settleDebounce(); // the post-connect recovery read fails
    expect(result.current.boardStatus).toBe('stale');
  });
});

