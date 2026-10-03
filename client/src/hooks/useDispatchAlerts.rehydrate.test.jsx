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

describe('an open queue re-reads when a visit with a loaded spray hold updates', () => {
  const sprayCard = {
    id: 'spray-1', type: 'lawn_spray_hold', severity: 'warn', tech_id: null, job_id: 'job-1', created_at: '2026-10-03T10:00:00Z', resolved_at: null,
    customer_first_name: 'Test', customer_last_name: 'Customer', service_type: 'Lawn Care Visit',
    payload: { for_date: '2026-10-03', window_start: '09:00:00', lines: ['Sample Herbicide: hold.'] },
  };
  const otherCard = { id: 'late-1', type: 'missed_photo', severity: 'info', tech_id: null, job_id: 'job-2', created_at: '2026-10-03T09:00:00Z', payload: {} };

  async function mountWithCards() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [sprayCard, otherCard] }) });
    const hook = renderHook(() => useDispatchAlerts());
    await vi.waitFor(() => expect(hook.result.current.alerts).toHaveLength(2));
    return hook;
  }
  afterEach(() => { vi.useRealTimers(); });

  it('a job_update for that job re-reads once and the superseded card disappears (even if the resolved packet is lost)', async () => {
    const { result } = await mountWithCards();
    // The read drops the edited visit's card (the server superseded it) and keeps the rest.
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [otherCard] }) });
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1', scheduled_date: '2026-10-08', window_start: '10:00:00' }); });
    expect(fetch).toHaveBeenCalledTimes(1); // debounced: nothing yet
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.alerts.map((a) => a.id)).toEqual(['late-1']);
  });

  it('a job_update for another job, or without a job id, triggers no read', async () => {
    await mountWithCards();
    await act(async () => {
      socketHandlers['dispatch:job_update']({ job_id: 'job-2' });
      socketHandlers['dispatch:job_update']({ job_id: 'job-99' });
      socketHandlers['dispatch:job_update']({});
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a burst of updates for the job is one read', async () => {
    await mountWithCards();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ alerts: [sprayCard, otherCard] }) });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) socketHandlers['dispatch:job_update']({ job_id: 'job-1' });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a card the re-read still returns (a valid visit) stays', async () => {
    const { result } = await mountWithCards();
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [sprayCard, otherCard] }) });
    await act(async () => { socketHandlers['dispatch:job_update']({ job_id: 'job-1' }); await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.alerts.map((a) => a.id).sort()).toEqual(['late-1', 'spray-1']);
  });
});

