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
