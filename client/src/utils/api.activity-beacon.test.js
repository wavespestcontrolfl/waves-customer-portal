// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('activity beacon transport', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('POSTs with keepalive, leaves the GET cache alone, and resolves the body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, enabled: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { default: api } = await import('./api.js');
    api.getCache.set('feed:x', { data: 1, ts: Date.now() });

    const res = await api.sendActivityBeacon('/customer/activity/page-view', { route: 'visits' });

    expect(res).toEqual({ ok: true, enabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/customer\/activity\/page-view$/);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, body: JSON.stringify({ route: 'visits' }) });
    expect(api.getCache.has('feed:x')).toBe(true);
  });

  it('resolves null (never throws) on a non-OK answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    const { default: api } = await import('./api.js');
    expect(await api.sendActivityBeacon('/customer/activity/page-view', { route: '!' })).toBeNull();
  });
});
