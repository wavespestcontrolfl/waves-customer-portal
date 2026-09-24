// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchBoard, TECH_ABSENCE_EVENT } from './useDispatchBoard';

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

describe('superseded refresh leaves no buffer behind (pre-push auditor P1 on PR #4678, round 3)', () => {
  it('B settles, a socket update arrives, A (older) settles, then C refreshes: C\'s snapshot wins', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const snapshot = (techId, stamp) => ({
      techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: stamp }],
      jobs: [{ id: 'job-1', technician_id: techId, status: 'confirmed', address: '123 Main St' }],
    });
    const a = deferredResponse(snapshot('tech-1', 'tA'));
    const b = deferredResponse(snapshot('tech-1', 'tB'));
    fetch.mockResolvedValueOnce(a.response).mockResolvedValueOnce(b.response);
    let pA; let pB;
    await act(async () => { pA = result.current.refreshTechs(); pB = result.current.refreshTechs(); });
    await act(async () => { b.release(); await pB; });
    expect(result.current.techs[0].updated_at).toBe('tB');

    // Nothing is pending from the board's point of view now (A is
    // superseded), so this update is applied live and NOT buffered.
    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-1', tech_id: 'tech-2', status: 'confirmed', address: '123 Main St' });
    });
    expect(result.current.jobs[0].technician_id).toBe('tech-2');

    await act(async () => { a.release(); await pA; });
    expect(result.current.techs[0].updated_at).toBe('tB');
    expect(result.current.jobs[0].technician_id).toBe('tech-2');

    // C's server read is the newest truth: the tech-2 event must not be
    // replayed over it.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot('tech-3', 'tC') });
    await act(async () => { await result.current.refreshTechs(); });
    expect(result.current.techs[0].updated_at).toBe('tC');
    expect(result.current.jobs[0].technician_id).toBe('tech-3');
  });

  it('a refresh that starts while another is pending discards what the older one buffered', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const a = deferredResponse({ techs: [], jobs: [{ id: 'job-1', technician_id: 'tech-1', status: 'confirmed', address: '123 Main St' }] });
    fetch.mockResolvedValueOnce(a.response);
    let pA;
    await act(async () => { pA = result.current.refreshTechs(); });
    // Buffered for A …
    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-1', tech_id: 'tech-2', status: 'confirmed', address: '123 Main St' });
    });
    // … but B starts afterwards; its server read (tech-3) already
    // post-dates that event, so B must not replay it.
    const b = deferredResponse({ techs: [], jobs: [{ id: 'job-1', technician_id: 'tech-3', status: 'confirmed', address: '123 Main St' }] });
    fetch.mockResolvedValueOnce(b.response);
    let pB;
    await act(async () => { pB = result.current.refreshTechs(); });
    await act(async () => { a.release(); await pA; b.release(); await pB; });
    expect(result.current.jobs[0].technician_id).toBe('tech-3');
  });
});

describe('initial hydration is load #1 of the same sequence (pre-push auditor P1 on PR #4678, round 4)', () => {
  it('a broadcast-triggered refresh during hydration supersedes the initial response', async () => {
    // The initial /board read is slow; an absence broadcast arrives and
    // its refresh returns first with the tech marked Out. The initial
    // response (older, out_today false) must not roll that back.
    const initial = deferredResponse({
      techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't0' }],
      jobs: [],
    });
    fetch.mockResolvedValueOnce(initial.response);
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(typeof socketHandlers['dispatch:tech_absence']).toBe('function'));

    const refreshed = deferredResponse({
      techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: true, updated_at: 't1' }],
      jobs: [],
    });
    fetch.mockResolvedValueOnce(refreshed.response);
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' });
    });
    await act(async () => { refreshed.release(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.techs[0].out_today).toBe(true);

    await act(async () => { initial.release(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.techs[0].out_today).toBe(true);
    expect(result.current.techs[0].updated_at).toBe('t1');
    expect(result.current.error).toBeNull();
  });

  it('a socket update that arrives mid-hydration survives the initial response', async () => {
    const initial = deferredResponse({
      techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't0' }],
      jobs: [{ id: 'job-1', technician_id: 'tech-1', status: 'confirmed', address: '123 Main St' }],
    });
    fetch.mockResolvedValueOnce(initial.response);
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(typeof socketHandlers['dispatch:job_update']).toBe('function'));

    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-1', tech_id: 'tech-2', status: 'confirmed', address: '123 Main St' });
    });
    await act(async () => { initial.release(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.jobs[0].technician_id).toBe('tech-2');
    expect(result.current.techs[0].name).toBe('Tech One');
  });

  it('an initial load that fails while still the latest sets error; one superseded by a successful refresh does not', async () => {
    fetch.mockRejectedValueOnce(new Error('boom'));
    const first = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.error).toBe('boom');
    first.unmount();
    for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];

    // The initial fetch is still pending when a broadcast refresh starts
    // and succeeds; the initial request then fails — superseded, so it
    // must not set `error` over a board that loaded fine.
    let failInitial;
    fetch.mockReturnValueOnce(new Promise((_resolve, reject) => { failInitial = reject; }));
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(typeof socketHandlers['dispatch:tech_absence']).toBe('function'));
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { failInitial(new Error('HTTP 500')); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.error).toBeNull();
    expect(result.current.techs[0].name).toBe('Tech One');
  });
});

describe('a failed refresh that superseded hydration settles the board (pre-push auditor P1 on PR #4678, round 5)', () => {
  it('sets error and ends loading, and a later successful refresh clears the error', async () => {
    let releaseInitial;
    fetch.mockReturnValueOnce(new Promise((resolve) => { releaseInitial = resolve; }));
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(typeof socketHandlers['dispatch:tech_absence']).toBe('function'));
    expect(result.current.loading).toBe(true);

    // The broadcast refresh supersedes hydration and then fails.
    fetch.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network down');

    // The superseded initial response is still dropped even now.
    await act(async () => {
      releaseInitial({ ok: true, json: async () => initialBoard });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(result.current.techs).toHaveLength(0);
    expect(result.current.error).toBe('network down');

    // A later refresh that succeeds hydrates the board and clears the error.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: false, absence_id: 'a-1' });
    });
    await waitFor(() => expect(result.current.techs).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('a failed refresh on an already-hydrated board does not set error', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetch.mockRejectedValueOnce(new Error('network down'));
    await act(async () => { await result.current.refreshTechs(); });
    expect(result.current.error).toBeNull();
    expect(result.current.techs).toHaveLength(1);
  });
});

describe('a refresh is the whole roster (Codex r5 P2 on PR #4678)', () => {
  it('drops a technician the /board response no longer lists', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [
          { id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't0' },
          { id: 'tech-2', name: 'Tech Two', status: 'idle', out_today: false, updated_at: 't0' },
        ],
        jobs: [],
      }),
    });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.techs).toHaveLength(2);

    // tech-2 was deactivated / went office-only: the roster omits them.
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ techs: [{ id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't1' }], jobs: [] }),
    });
    await act(async () => { await result.current.refreshTechs(); });
    expect(result.current.techs.map((t) => t.id)).toEqual(['tech-1']);
  });
});

describe('a tech_status for a tech the roster does not carry re-reads the board (Codex r7 P2 on PR #4678)', () => {
  it('re-fetches /board (which carries out_today) instead of synthesizing a row; a stale ping is ignored', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Stale location for an unknown tech: nothing happens.
    await act(async () => {
      socketHandlers['dispatch:tech_status']({ tech_id: 'tech-2', status: 'idle', lat: null, lng: null, updated_at: 't1' });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.techs.map((t) => t.id)).toEqual(['tech-1']);

    // Fresh location for an unknown tech who is marked out today.
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        techs: [
          { id: 'tech-1', name: 'Tech One', status: 'idle', out_today: false, updated_at: 't1' },
          { id: 'tech-2', name: 'Tech Two', status: 'en_route', out_today: true, updated_at: 't1' },
        ],
        jobs: [],
      }),
    });
    await act(async () => {
      socketHandlers['dispatch:tech_status']({ tech_id: 'tech-2', status: 'en_route', lat: 27.3, lng: -82.5, updated_at: new Date().toISOString(), location_updated_at: new Date().toISOString() });
    });
    await waitFor(() => expect(result.current.techs).toHaveLength(2));
    const added = result.current.techs.find((t) => t.id === 'tech-2');
    expect(added.name).toBe('Tech Two');
    expect(added.out_today).toBe(true);
  });
});

describe('absence broadcast relay (Codex r8 P2 on PR #4678)', () => {
  it('re-emits every dispatch:tech_absence as a window event carrying the payload', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    const { result } = renderHook(() => useDispatchBoard());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const seen = [];
    const listener = (e) => seen.push(e.detail);
    window.addEventListener(TECH_ABSENCE_EVENT, listener);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => initialBoard });
    await act(async () => {
      socketHandlers['dispatch:tech_absence']({ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' });
    });
    window.removeEventListener(TECH_ABSENCE_EVENT, listener);
    expect(seen).toEqual([{ tech_id: 'tech-1', date: '2026-09-30', out: true, absence_id: 'a-1' }]);
  });
});
