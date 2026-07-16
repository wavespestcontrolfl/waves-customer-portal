// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('API token publication', () => {
  const jwtFor = (payload) => {
    const encode = (value) => btoa(JSON.stringify(value))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.test`;
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes the rotated refresh token before the access-token storage event', async () => {
    const writes = [];
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: (key, value) => writes.push([key, value]),
      removeItem: (key) => writes.push([key, null]),
    });
    const { default: api } = await import('./api.js');

    api.setTokens('access-next', 'refresh-next');

    expect(writes).toEqual([
      ['waves_refresh_token', 'refresh-next'],
      ['waves_token', 'access-next'],
    ]);
  });

  it('rebuilds a property-switch body after refresh-token rotation', async () => {
    const store = {
      waves_token: jwtFor({ customerId: 'customer-a', sessionId: 'family-a' }),
      waves_refresh_token: 'refresh-old',
    };
    vi.stubGlobal('localStorage', {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    });

    const calls = [];
    const response = (status, data) => ({
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => data,
      text: async () => JSON.stringify(data),
    });
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, body: options.body, bodyFactory: options.bodyFactory });
      if (calls.length === 1) return response(401, { error: 'expired' });
      if (calls.length === 2) {
        return response(200, {
          token: jwtFor({ customerId: 'customer-a', sessionId: 'family-a' }),
          refreshToken: 'refresh-next',
        });
      }
      return response(200, { token: 'property-access', refreshToken: 'property-refresh' });
    }));
    const { default: api } = await import('./api.js');

    await api.selectAuthProperty('22222222-2222-4222-8222-222222222222');

    expect(calls.map((call) => call.body)).toEqual([
      JSON.stringify({
        customerId: '22222222-2222-4222-8222-222222222222',
        refreshToken: 'refresh-old',
      }),
      JSON.stringify({ refreshToken: 'refresh-old' }),
      JSON.stringify({
        customerId: '22222222-2222-4222-8222-222222222222',
        refreshToken: 'refresh-next',
      }),
    ]);
    expect(calls.every((call) => call.bodyFactory === undefined)).toBe(true);
  });

  it('coordinates simultaneous refreshes across tabs and posts the token once', async () => {
    const store = {
      waves_token: 'access-old',
      waves_refresh_token: 'refresh-old',
    };
    vi.stubGlobal('localStorage', {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    });
    let lockTail = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn((_name, _options, callback) => {
          const run = lockTail.then(callback);
          lockTail = run.catch(() => {});
          return run;
        }),
      },
    });
    const refreshFetch = vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ token: 'access-next', refreshToken: 'refresh-next' }),
    }));
    vi.stubGlobal('fetch', refreshFetch);
    const { ApiClient } = await import('./api.js');
    const firstTab = new ApiClient();
    const secondTab = new ApiClient();

    await expect(Promise.all([firstTab.attemptRefresh(), secondTab.attemptRefresh()]))
      .resolves.toEqual(['refreshed', 'refreshed']);

    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(firstTab.refreshToken).toBe('refresh-next');
    expect(secondTab.refreshToken).toBe('refresh-next');
    expect(secondTab.token).toBe('access-next');
  });

  it('does not resurrect credentials when a slow refresh finishes after logout', async () => {
    const store = {
      waves_token: 'access-old',
      waves_refresh_token: 'refresh-old',
    };
    vi.stubGlobal('localStorage', {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    });
    vi.stubGlobal('navigator', {
      locks: { request: (_name, _options, callback) => callback() },
    });
    let finishRefresh;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finishRefresh = resolve; })));
    const { ApiClient } = await import('./api.js');
    const api = new ApiClient();

    const refreshing = api.attemptRefresh();
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    api.clearTokens();
    finishRefresh({
      status: 200,
      ok: true,
      json: async () => ({ token: 'access-stale', refreshToken: 'refresh-stale' }),
    });

    await expect(refreshing).resolves.toBe('rejected');
    expect(api.token).toBeNull();
    expect(api.refreshToken).toBeNull();
    expect(store).toEqual({});
  });

  it('never retries an old mutation after the active property changes', async () => {
    const originalAccess = jwtFor({ customerId: 'customer-a', sessionId: 'family-a' });
    const targetAccess = jwtFor({ customerId: 'customer-b', sessionId: 'family-a' });
    const store = {
      waves_token: originalAccess,
      waves_refresh_token: 'refresh-a',
    };
    vi.stubGlobal('localStorage', {
      getItem: (key) => store[key] || null,
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    });
    vi.stubGlobal('navigator', {
      locks: { request: (_name, _options, callback) => callback() },
    });
    const calls = [];
    let finishRefresh;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) {
        return {
          status: 401,
          ok: false,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'expired' }),
        };
      }
      if (calls.length === 2) {
        return new Promise((resolve) => { finishRefresh = resolve; });
      }
      throw new Error('old request body was retried under the target property');
    }));
    const { ApiClient } = await import('./api.js');
    const api = new ApiClient();

    const mutation = api.request('/property/preferences', {
      method: 'PUT',
      body: JSON.stringify({ gateCode: 'old-property-secret' }),
    });
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    api.setTokens(targetAccess, 'refresh-b');
    finishRefresh({
      status: 200,
      ok: true,
      json: async () => ({
        token: jwtFor({ customerId: 'customer-a', sessionId: 'family-a' }),
        refreshToken: 'refresh-a-next',
      }),
    });

    await expect(mutation).rejects.toMatchObject({ requestSuperseded: true });
    expect(calls).toHaveLength(2);
    expect(api.token).toBe(targetAccess);
    expect(api.refreshToken).toBe('refresh-b');
  });
});
