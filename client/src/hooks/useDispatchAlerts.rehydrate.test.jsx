// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchAlerts } from './useDispatchAlerts';
import AlertCard from '../components/dispatch/AlertCard';

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

describe('a bare dispatch:alert broadcast is rehydrated for cards that need the joined identity', () => {
  const bare = {
    id: 'spray-1', type: 'lawn_spray_hold', severity: 'warn', tech_id: null, job_id: 'job-1', created_at: '2026-10-03T10:00:00Z', resolved_at: null,
    payload: { source: 'lawn_preday_spray_check', for_date: '2026-10-03', window_start: '09:00:00', lines: ['Sample Herbicide: hold. Wind forecast up to 21 mph.'] },
  };
  const enriched = { ...bare, customer_first_name: 'Test', customer_last_name: 'Customer', service_type: 'Lawn Care Visit', window_start: '09:00:00', window_end: '11:00:00' };

  it('a live lawn_spray_hold shows its customer and service once the queue is re-read', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [] }) });
    const { result } = renderHook(() => useDispatchAlerts());
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [enriched] }) });
    await act(async () => { socketHandlers['dispatch:alert'](bare); });
    await waitFor(() => expect(result.current.alerts[0]?.customer_first_name).toBe('Test'));
    expect(fetch).toHaveBeenCalledTimes(2);

    render(<AlertCard alert={result.current.alerts[0]} />);
    expect(screen.getByText('Test C. · Lawn Care Visit')).toBeTruthy();
    expect(screen.getByText(/Wind forecast up to 21 mph/)).toBeTruthy();
  });

  it('other bare broadcasts do not trigger a re-read', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [] }) });
    const { result } = renderHook(() => useDispatchAlerts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { socketHandlers['dispatch:alert']({ ...bare, id: 'other-1', type: 'missed_photo' }); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('a visit update asks the server about THAT visit (job-scoped read)', () => {
  const sprayCard = {
    id: 'spray-1', type: 'lawn_spray_hold', severity: 'warn', tech_id: null, job_id: 'job-1', created_at: '2026-10-03T10:00:00Z', resolved_at: null,
    customer_first_name: 'Test', customer_last_name: 'Customer', service_type: 'Lawn Care Visit',
    payload: { for_date: '2026-10-03', window_start: '09:00:00', lines: ['Sample Herbicide: hold.'] },
  };
  const otherCard = { id: 'late-1', type: 'missed_photo', severity: 'info', tech_id: null, job_id: 'job-2', created_at: '2026-10-03T09:00:00Z', payload: {} };
  const jobUrls = () => fetch.mock.calls.map(([url]) => url).filter((u) => u.includes('job_id='));

  async function mountWithCards(initial = [sprayCard, otherCard]) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: initial }) });
    const hook = renderHook(() => useDispatchAlerts());
    await vi.waitFor(() => expect(hook.result.current.alerts).toHaveLength(initial.length));
    return hook;
  }
  const answer = (alerts) => fetch.mockResolvedValue({ ok: true, json: async () => ({ alerts }) });
  afterEach(() => { vi.useRealTimers(); });

  it('the stale card is removed when the job-scoped read has no open spray hold, and nothing else is touched', async () => {
    const { result } = await mountWithCards();
    answer([]);
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1', scheduled_date: '2026-10-08' }); });
    expect(fetch).toHaveBeenCalledTimes(1); // debounced: nothing yet
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(jobUrls()).toEqual([expect.stringContaining('/admin/dispatch/alerts?unresolved=true&job_id=job-1')]);
    expect(result.current.alerts.map((a) => a.id)).toEqual(['late-1']);
  });

  it('a changed card replaces the loaded one', async () => {
    const { result } = await mountWithCards();
    const fresh = { ...sprayCard, id: 'spray-2', payload: { ...sprayCard.payload, window_start: '14:00:00', lines: ['Sample Herbicide: hold. New window.'] } };
    answer([fresh]);
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1' }); await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.alerts.map((a) => a.id).sort()).toEqual(['late-1', 'spray-2']);
    expect(result.current.alerts.find((a) => a.id === 'spray-2').payload.window_start).toBe('14:00:00');
  });

  it('a long queue (50+ other alerts) no longer matters: the answer is about the job, not the page', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `x-${i}`, type: 'missed_photo', severity: 'info', tech_id: null, job_id: `other-${i}`, created_at: `2026-10-03T08:${String(i).padStart(2, '0')}:00Z`, payload: {} }));
    const { result } = await mountWithCards([sprayCard, ...many]);
    answer([sprayCard]); // still valid
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1' }); await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.alerts.some((a) => a.id === 'spray-1')).toBe(true);
    expect(result.current.alerts).toHaveLength(61);
    answer([]);
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1' }); await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.alerts.some((a) => a.id === 'spray-1')).toBe(false);
    expect(result.current.alerts).toHaveLength(60);
  });

  it('a job_update for another job or without a job id triggers no read', async () => {
    await mountWithCards();
    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-2' });
      socketHandlers['dispatch:job_update']({ job_id: 'job-99' });
      socketHandlers['dispatch:job_update']({});
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a burst of updates for the job is one request', async () => {
    await mountWithCards();
    answer([sprayCard]);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) socketHandlers['dispatch:job_update']({ job_id: 'job-1' });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(jobUrls()).toHaveLength(1);
  });

  it('a failed job-scoped read leaves the board as it was', async () => {
    const { result } = await mountWithCards();
    fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1' }); await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.alerts.map((a) => a.id).sort()).toEqual(['late-1', 'spray-1']);
  });
});

describe('a job-scoped refresh applies safely against live state', () => {
  const base = (id, job, over = {}) => ({
    id, type: 'lawn_spray_hold', severity: 'warn', tech_id: null, job_id: job, created_at: '2026-10-03T10:00:00Z', resolved_at: null,
    customer_first_name: 'Test', customer_last_name: 'Customer', service_type: 'Lawn Care Visit',
    payload: { for_date: '2026-10-03', window_start: '09:00:00', lines: [`${id} hold.`] }, ...over,
  });
  const other = { id: 'late-1', type: 'missed_photo', severity: 'info', tech_id: null, job_id: 'job-3', created_at: '2026-10-03T09:00:00Z', payload: {} };

  // fetch: the plain queue read answers `initial`; each job-scoped read waits on a deferred the test settles.
  function setup(initial) {
    const pending = [];
    fetch.mockImplementation((url) => {
      if (!String(url).includes('job_id=')) return Promise.resolve({ ok: true, json: async () => ({ alerts: initial }) });
      return new Promise((resolve) => pending.push({ url, resolve }));
    });
    return pending;
  }
  const reply = (req, alerts, ok = true) => req.resolve({ ok, status: ok ? 200 : 500, json: async () => ({ alerts }) });
  const ids = (result) => result.current.alerts.map((a) => a.id).sort();
  afterEach(() => { vi.useRealTimers(); });

  async function mount(initial) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = setup(initial);
    const hook = renderHook(() => useDispatchAlerts());
    await vi.waitFor(() => expect(hook.result.current.alerts).toHaveLength(initial.length));
    return { ...hook, pending };
  }
  const poke = async (jobId) => { await act(async () => { socketHandlers['dispatch:job_update']({ job_id: jobId }); await vi.advanceTimersByTimeAsync(500); }); };

  it('a hold for the job that ARRIVES while the request is in flight survives the older response', async () => {
    const { result, pending } = await mount([base('spray-1', 'job-1'), other]);
    await poke('job-1');
    expect(pending).toHaveLength(1);
    // The fresh card for the new window arrives by broadcast mid-request.
    await act(async () => { socketHandlers['dispatch:alert'](base('spray-2', 'job-1', { created_at: '2026-10-03T11:00:00Z' })); });
    expect(ids(result)).toEqual(['late-1', 'spray-1', 'spray-2']);
    // The response was generated before spray-2 existed: it has no open hold.
    await act(async () => { reply(pending[0], []); });
    expect(ids(result)).toEqual(['late-1', 'spray-2']); // only the KNOWN stale card went
  });

  it('a known card the server did not return is removed; one it returned is upserted with the server copy', async () => {
    const { result, pending } = await mount([base('spray-1', 'job-1'), base('spray-9', 'job-1', { created_at: '2026-10-03T09:30:00Z' }), other]);
    await poke('job-1');
    const updated = base('spray-1', 'job-1', { payload: { for_date: '2026-10-03', window_start: '14:00:00', lines: ['moved.'] } });
    await act(async () => { reply(pending[0], [updated]); });
    expect(ids(result)).toEqual(['late-1', 'spray-1']);
    expect(result.current.alerts.find((a) => a.id === 'spray-1').payload.window_start).toBe('14:00:00');
  });

  it('an out-of-order older response is discarded entirely', async () => {
    const { result, pending } = await mount([base('spray-1', 'job-1'), other]);
    await poke('job-1');   // request A
    await poke('job-1');   // request B (newer)
    expect(pending).toHaveLength(2);
    await act(async () => { reply(pending[1], [base('spray-2', 'job-1')]); });
    expect(ids(result)).toEqual(['late-1', 'spray-2']);
    await act(async () => { reply(pending[0], [base('spray-1', 'job-1')]); }); // older: would resurrect spray-1
    expect(ids(result)).toEqual(['late-1', 'spray-2']);
  });

  it('a failed request changes nothing', async () => {
    const { result, pending } = await mount([base('spray-1', 'job-1'), other]);
    await poke('job-1');
    await act(async () => { reply(pending[0], [], false); });
    expect(ids(result)).toEqual(['late-1', 'spray-1']);
  });

  it('other jobs\' holds and other alert types are never touched', async () => {
    const { result, pending } = await mount([base('spray-1', 'job-1'), base('spray-2', 'job-2'), other]);
    await poke('job-1');
    await act(async () => { reply(pending[0], [base('spray-2', 'job-2', { payload: { lines: ['tampered.'] } }), { ...other, id: 'late-2' }]); });
    // job-1's hold is gone; the response's rows for another job or type are ignored, and job-2's copy is unchanged.
    expect(ids(result)).toEqual(['late-1', 'spray-2']);
    expect(result.current.alerts.find((a) => a.id === 'spray-2').payload.lines).toEqual(['spray-2 hold.']);
  });
});

