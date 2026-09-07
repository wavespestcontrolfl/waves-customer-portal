// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useIntelligenceBar } from './useIntelligenceBar';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('Clear prevents a late response or cleanup from replacing the next request', async () => {
  const settles = [];
  vi.stubGlobal('fetch', vi.fn(url => url.includes('/query') ? new Promise(resolve => settles.push(resolve))
    : Promise.resolve({ ok: true, json: async () => ({ actions: [] }) })));
  const { result } = renderHook(() => useIntelligenceBar());
  let first, second;
  act(() => { first = result.current.submit('Old task'); });
  act(() => result.current.clear());
  act(() => { second = result.current.submit('New task'); });
  await act(async () => { settles[0]({ ok: true, json: async () => ({ response: 'Old result' }) }); await first; });
  expect(result.current.response).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => { settles[1]({ ok: true, json: async () => ({ response: 'New result' }) }); await second; });
  expect(result.current.response).toBe('New result');
});
