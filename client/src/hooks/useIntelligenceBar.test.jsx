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

it.each([null, 'select-target', 'resume'])('Clear isolates a delayed task %s from the next query', async operation => {
  let settleTask, settleQuery;
  vi.stubGlobal('fetch', vi.fn(url => url.includes('/tasks/old-task') ? new Promise(resolve => { settleTask = resolve; })
    : url.endsWith('/query') ? new Promise(resolve => { settleQuery = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ actions: [], tasks: [] }) })));
  const { result } = renderHook(() => useIntelligenceBar({ context: 'dispatch' }));
  let old, current;
  act(() => { old = result.current.refreshTask('old-task', operation, { customer_id: 'old-customer' }); });
  act(() => result.current.clear());
  act(() => { current = result.current.submit('A new request'); });
  await act(async () => { settleTask({ ok: true, json: async () => ({ taskId: 'old-task', response: 'Late task result' }) }); await old; });
  expect(result.current.activeTask).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => { settleQuery({ ok: true, json: async () => ({ taskId: 'new-task', response: 'Current result' }) }); await current; });
  expect(result.current.activeTask.taskId).toBe('new-task');
});

it('a changed record key rejects a delayed task response and releases loading', async () => {
  let settle, key = 'stop-a';
  vi.stubGlobal('fetch', vi.fn(url => url.includes('/tasks/old-task') ? new Promise(resolve => { settle = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ actions: [], tasks: [] }) })));
  const { result } = renderHook(() => useIntelligenceBar({ getRequestKey: () => key }));
  let request;
  act(() => { request = result.current.refreshTask('old-task'); });
  key = 'stop-b';
  await act(async () => { settle({ ok: true, json: async () => ({ taskId: 'old-task', response: 'Old stop result' }) }); await request; });
  expect(result.current.activeTask).toBeNull();
  expect(result.current.loading).toBe(false);
});

it('the isolated Agent Estimate hook does not load platform task history', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ actions: [], response: 'Estimate draft advice' }) }));
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => useIntelligenceBar({ context: 'agent_estimate' }));
  await act(async () => result.current.submit('Prepare a draft'));
  expect(result.current.response).toBe('Estimate draft advice');
  expect(result.current.tasksAvailable).toBe(false);
  expect(fetch.mock.calls.some(([url]) => url.includes('/tasks'))).toBe(false);
});

it('a delayed history probe survives a concurrent failed query', async () => {
  let settleHistory;
  vi.stubGlobal('fetch', vi.fn(url => url.includes('/tasks?') ? new Promise(resolve => { settleHistory = resolve; })
    : Promise.resolve(url.endsWith('/query') ? { ok: false, status: 503, json: async () => ({ error: 'Model unavailable' }) }
      : { ok: true, json: async () => ({ actions: [] }) })));
  const { result } = renderHook(() => useIntelligenceBar({ context: 'dispatch' }));
  await act(async () => result.current.submit('A new request'));
  await act(async () => settleHistory({ ok: true, json: async () => ({ tasks: [{ id: 'saved-task' }] }) }));
  expect(result.current.tasksAvailable).toBe(true);
  expect(result.current.savedTasks).toEqual([{ id: 'saved-task' }]);
  expect(result.current.response).toBe('Error: Model unavailable');
});

it('a server failure keeps the request key so the retry replays the saved task; a 4xx answer releases it', async () => {
  const bodies = [];
  let status = 503;
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (url.endsWith('/query')) { bodies.push(JSON.parse(options.body)); return Promise.resolve({ ok: false, status, json: async () => ({ error: 'Request failed' }) }); }
    return Promise.resolve({ ok: true, json: async () => ({ actions: [] }) });
  }));
  const { result } = renderHook(() => useIntelligenceBar({ context: 'dispatch' }));
  await act(async () => result.current.submit('Same request'));
  await act(async () => result.current.submit('Same request'));
  expect(bodies[1].request_key).toBe(bodies[0].request_key);
  status = 409;
  await act(async () => result.current.submit('Same request'));
  expect(bodies[2].request_key).toBe(bodies[0].request_key);
  await act(async () => result.current.submit('Same request'));
  expect(bodies[3].request_key).not.toBe(bodies[0].request_key);
});
