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
