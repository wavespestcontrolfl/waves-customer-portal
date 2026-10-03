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
