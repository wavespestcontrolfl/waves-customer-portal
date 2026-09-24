// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchBoard } from './useDispatchBoard';

// Handlers the hook registers, by event name, so a test can fire a
// broadcast at the hook exactly as socket.io would.
const socketHandlers = vi.hoisted(() => ({}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn((event, handler) => { socketHandlers[event] = handler; }),
    off: vi.fn((event) => { delete socketHandlers[event]; }),
    disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  localStorage.setItem('waves_admin_token', 'test-token');
});
afterEach(() => {
  cleanup();
  for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
  vi.unstubAllGlobals();
  localStorage.clear();
});

const initialBoard = {
  techs: [
    { id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't0' },
  ],
  jobs: [
    { id: 'job-1', technician_id: 'tech-1', status: 'confirmed', address: '123 Main St' },
  ],
};

describe('refreshTechs (Codex P2 on PR #4678)', () => {
  it('re-fetches the board, merges fresh tech rows, and replaces jobs[] from the same response', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.techs[0].out_today).toBe(false);
    const jobsBefore = result.current.jobs;

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 't1' }],
        // refreshTechs must not apply them.
        jobs: [{ id: 'job-1', technician_id: 'tech-2', status: 'confirmed', address: '456 Moved Ln' }],
      }),
    });

    await act(async () => { await result.current.refreshTechs(); });

    expect(result.current.techs[0].out_today).toBe(true);
    expect(result.current.techs[0].updated_at).toBe('t1');
    // jobs[] is replaced from the refresh response so redistributed stops
    // show under their new technician without a socket round-trip.
    expect(result.current.jobs).not.toBe(jobsBefore);
    expect(result.current.jobs[0].technician_id).toBe('tech-2');
  });

  it('leaves the roster as-is and does not throw when the refresh fetch fails', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetch.mockRejectedValueOnce(new Error('network down'));
    await act(async () => { await result.current.refreshTechs(); });

    expect(result.current.error).toBeNull();
    expect(result.current.techs[0].out_today).toBe(false);
  });
});


describe('dispatch:tech_absence broadcast (pre-push auditor P1 on PR #4678)', () => {
  it('re-reads the roster when another tab marks a tech out or back, so out_today flips without a reload', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(typeof socketHandlers['dispatch:tech_absence']).toBe('function');
    expect(result.current.techs[0].out_today).toBe(false);

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 't1' }],
        jobs: [],
      }),
    });
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' });
    });
    await waitFor(() => expect(result.current.techs[0].out_today).toBe(true));
    // The flag came from the server's /board read, not from the payload.
    expect(fetch).toHaveBeenCalledTimes(2);

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't2' }],
        jobs: [],
      }),
    });
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: false, absence_id: 'a-1' });
    });
    await waitFor(() => expect(result.current.techs[0].out_today).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('ignores a malformed broadcast (no tech_id) without a fetch', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { socketHandlers['dispatch:tech_absence']({}); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('unregisters the handler on unmount', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result, unmount } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(socketHandlers['dispatch:tech_absence']).toBeUndefined();
  });
});

/** A fetch response whose body resolves only when the test says so. */
function deferredResponse(body) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const response = { ok: true, json: () => gate.then(() => body) };
  return { response, release };
}

describe('refresh ordering + socket replay (pre-push auditor P1 on PR #4678)', () => {
  it('an older refresh that settles LAST does not re-mark a tech Out after a newer one cleared them', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Refresh A (mark-out: out_today true) starts first, refresh B (tech
    // is back: out_today false) second; B's body arrives before A's.
    const a = deferredResponse({ techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 'tA' }], jobs: [] });
    const b = deferredResponse({ techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 'tB' }], jobs: [] });
    fetch.mockResolvedValueOnce(a.response).mockResolvedValueOnce(b.response);

    let pA; let pB;
    await act(async () => { pA = result.current.refreshTechs(); pB = result.current.refreshTechs(); });
    await act(async () => { b.release(); await pB; });
    expect(result.current.techs[0].out_today).toBe(false);
    expect(result.current.techs[0].updated_at).toBe('tB');

    await act(async () => { a.release(); await pA; });
    // A was superseded: its stale reading is dropped, not applied.
    expect(result.current.techs[0].out_today).toBe(false);
    expect(result.current.techs[0].updated_at).toBe('tB');
  });

  it('a job_update and a tech_status that arrive while a refresh is pending survive the refresh', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The server read still shows job-1 on tech-1 and tech-1 idle …
    const pending = deferredResponse({
      techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 't1' }],
      jobs: [{ id: 'job-1', technician_id: 'tech-1', status: 'confirmed', address: '123 Main St' }],
    });
    fetch.mockResolvedValueOnce(pending.response);
    let p;
    await act(async () => { p = result.current.refreshTechs(); });

    // … but while it is in flight, the board learns job-1 moved to
    // tech-2 and tech-1 went en_route.
    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-1', tech_id: 'tech-2', status: 'confirmed', address: '123 Main St' });
      socketHandlers['dispatch:tech_status']({ tech_id: 'tech-1', status: 'en_route', lat: 27.3, lng: -82.5, updated_at: 't2' });
    });
    expect(result.current.jobs[0].technician_id).toBe('tech-2');
    expect(result.current.techs[0].status).toBe('en_route');

    await act(async () => { pending.release(); await p; });
    // The refresh applied (out_today came from it) but did not clobber
    // the newer socket state.
    expect(result.current.techs[0].out_today).toBe(true);
    expect(result.current.techs[0].status).toBe('en_route');
    expect(result.current.jobs[0].technician_id).toBe('tech-2');
  });

  it('socket updates that arrive with no refresh pending are applied once and not buffered for a later refresh', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-1', tech_id: 'tech-2', status: 'confirmed', address: '123 Main St' });
    });
    expect(result.current.jobs[0].technician_id).toBe('tech-2');

    // A later refresh whose server read has job-1 back on tech-1 wins:
    // nothing stale is replayed over it.
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't3' }],
        jobs: [{ id: 'job-1', technician_id: 'tech-1', status: 'confirmed', address: '123 Main St' }],
      }),
    });
    await act(async () => { await result.current.refreshTechs(); });
    expect(result.current.jobs[0].technician_id).toBe('tech-1');
  });
});
