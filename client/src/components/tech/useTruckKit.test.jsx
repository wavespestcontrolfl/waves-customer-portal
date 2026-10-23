// @vitest-environment jsdom
// useTruckKit: a reload aborts the read in flight and a superseded answer
// never overwrites a fresher one (latest wins).
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useTruckKit from './useTruckKit';

const answers = [];
beforeEach(() => {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  vi.stubGlobal('fetch', vi.fn((url, { signal } = {}) => new Promise((resolve, reject) => {
    const entry = { resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }) };
    answers.push(entry);
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })));
});
afterEach(() => { answers.length = 0; vi.unstubAllGlobals(); localStorage.clear(); });

it('a reload aborts the mount read; the fresh answer stands and a late stale one is ignored', async () => {
  const { result } = renderHook(() => useTruckKit());
  expect(answers).toHaveLength(1);
  act(() => { result.current.reload(); });
  expect(answers).toHaveLength(2);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { answers[1].resolve({ enabled: true, gaps: [{ serviceId: 'v2' }] }); });
  await waitFor(() => expect(result.current.data?.gaps).toEqual([{ serviceId: 'v2' }]));
  // The first read answering late (had it not been aborted) changes nothing.
  await act(async () => { answers[0].resolve({ enabled: true, gaps: [] }); });
  expect(result.current.data?.gaps).toEqual([{ serviceId: 'v2' }]);
  expect(result.current.loading).toBe(false);
});
