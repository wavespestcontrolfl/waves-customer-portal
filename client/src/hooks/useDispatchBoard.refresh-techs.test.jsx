// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchBoard } from './useDispatchBoard';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  localStorage.setItem('waves_admin_token', 'test-token');
});
afterEach(() => {
  cleanup();
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
  it('re-fetches the board and merges fresh tech rows without touching jobs[]', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.techs[0].out_today).toBe(false);
    const jobsBefore = result.current.jobs;

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 't1' }],
        // A real board refresh answer would still carry jobs, but
        // refreshTechs must not apply them.
        jobs: [{ id: 'job-1', technician_id: 'tech-2', status: 'confirmed', address: 'should not apply' }],
      }),
    });

    await act(async () => { await result.current.refreshTechs(); });

    expect(result.current.techs[0].out_today).toBe(true);
    expect(result.current.techs[0].updated_at).toBe('t1');
    // jobs[] reference and content are untouched by refreshTechs.
    expect(result.current.jobs).toBe(jobsBefore);
    expect(result.current.jobs[0].technician_id).toBe('tech-1');
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
