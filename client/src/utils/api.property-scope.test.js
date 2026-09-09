// The saved-property API calls: the list asks for the scope, the switch carries
// propertyId only when given (profile-only switches keep today's exact body),
// and the per-entry next-visit read hits its route.
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('api saved-property calls', () => {
  let api; let calls;
  beforeEach(async () => {
    vi.resetModules();
    calls = [];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), body: opts.body, method: opts.method || 'GET' });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    ({ default: api } = await import('./api.js'));
    api.setTokens('access-1', 'refresh-1');
  });

  it('getAuthProperties adds the scope only when asked', async () => {
    await api.getAuthProperties();
    await api.getAuthProperties({ scope: 'saved' });
    expect(calls.map((c) => c.url.replace(/^.*\/api/, ''))).toEqual(['/auth/properties', '/auth/properties?scope=saved']);
  });

  it('selectAuthProperty sends propertyId only when given', async () => {
    await api.selectAuthProperty('11111111-1111-4111-8111-111111111111');
    await api.selectAuthProperty('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(calls.map((c) => c.body)).toEqual([
      JSON.stringify({ customerId: '11111111-1111-4111-8111-111111111111', refreshToken: 'refresh-1' }),
      JSON.stringify({ customerId: '11111111-1111-4111-8111-111111111111', propertyId: '22222222-2222-4222-8222-222222222222', refreshToken: 'refresh-1' }),
    ]);
  });

  it('getSavedPropertiesNext reads the per-entry route', async () => {
    await api.getSavedPropertiesNext();
    expect(calls[0].url).toMatch(/\/schedule\/properties-next$/);
  });
});
