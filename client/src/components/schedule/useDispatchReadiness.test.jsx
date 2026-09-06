// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useDispatchReadiness from './useDispatchReadiness';

const service = (id, status = 'confirmed') => ({ id, status });
const response = visits => ({ ok: true, json: async () => ({ enabled: true, visits }) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('page readiness reader', () => {
  it('fetches bounded batches once for both layouts and skips completed visits', async () => {
    const fetch = vi.fn(async url => response(new URL(url, 'http://localhost').searchParams.get('serviceIds').split(',').map(serviceId => ({ serviceId, issues: [] }))));
    vi.stubGlobal('fetch', fetch);
    const services = Array.from({ length: 8 }, (_, i) => service(`id-${i}`)).concat(service('completed', 'completed'));
    const { result } = renderHook(() => useDispatchReadiness({ services, date: '2026-09-04', active: true }));
    await waitFor(() => expect(result.current?.['id-7']?.issues).toEqual([]));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => !url.includes('completed'))).toBe(true);
  });

  it('cannot show an old date’s late response on the selected date', async () => {
    let resolveOld;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(response([{ serviceId: 'new', issues: [{ label: 'Weather unknown' }] }])));
    const { result, rerender } = renderHook(props => useDispatchReadiness(props), { initialProps: { services: [service('old')], date: '2026-09-04', active: true } });
    rerender({ services: [service('new')], date: '2026-09-05', active: true });
    await waitFor(() => expect(result.current?.new).toBeDefined());
    await act(async () => resolveOld(response([{ serviceId: 'old', issues: [{ label: 'Weather hold' }] }])));
    expect(result.current.old).toBeUndefined();
    expect(result.current.new.issues[0].label).toBe('Weather unknown');
  });

  it('hides on gate-off and does no work outside the day view', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) });
    vi.stubGlobal('fetch', fetch);
    const props = { services: [service('one')], date: '2026-09-04', active: false };
    const { result, rerender } = renderHook(input => useDispatchReadiness(input), { initialProps: props });
    expect(fetch).not.toHaveBeenCalled();
    rerender({ ...props, active: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();
  });
});
