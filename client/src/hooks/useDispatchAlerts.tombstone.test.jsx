// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDispatchAlerts, TECH_OUT_ALERTS_EVENT } from './useDispatchAlerts';

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

const card = { id: 'alert-1', type: 'tech_out_overflow', tech_id: 'tech-1', created_at: '2026-09-24T12:00:00Z', payload: {} };

describe('HTTP resolution tombstones a card (Codex r8 P2 on #4759)', () => {
  it('a card resolved by this tab\'s PATCH is never resurrected by a late dispatch:alert, and the drawer is told', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [card] }) });
    const { result } = renderHook(() => useDispatchAlerts());
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    const relayed = vi.fn();
    window.addEventListener(TECH_OUT_ALERTS_EVENT, relayed);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'alert-1' }) });
    await act(async () => { await result.current.resolveAlert('alert-1'); });
    expect(result.current.alerts).toHaveLength(0);
    expect(relayed).toHaveBeenCalledTimes(1);
    expect(relayed.mock.calls[0][0].detail).toEqual({ tech_id: 'tech-1' });
    window.removeEventListener(TECH_OUT_ALERTS_EVENT, relayed);

    // The socket's resolved packet never arrives; a late annotation does.
    await act(async () => { socketHandlers['dispatch:alert']({ ...card, payload: { auto_attempt: { reason: 'window_occupied' } } }); });
    expect(result.current.alerts).toHaveLength(0);
  });

  it('resolve-all tombstones every cleared id', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [card] }) });
    const { result } = renderHook(() => useDispatchAlerts());
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ alert_ids: ['alert-1'] }) });
    await act(async () => { await result.current.clearAlerts(); });
    await act(async () => { socketHandlers['dispatch:alert'](card); });
    expect(result.current.alerts).toHaveLength(0);
  });
});
