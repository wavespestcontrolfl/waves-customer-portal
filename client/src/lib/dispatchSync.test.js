// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDispatchSync } from './dispatchSync';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestDispatchSync', () => {
  it('returns a successful sync response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'Synced 3 jobs' }),
    });

    await expect(requestDispatchSync({ apiBase: '/api', date: '2026-07-15', token: 'token' }))
      .resolves.toEqual({ message: 'Synced 3 jobs' });
  });

  it('rejects an HTTP error instead of reporting a zero-job success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Dispatch bridge unavailable' }),
    });

    await expect(requestDispatchSync({ apiBase: '/api', date: '2026-07-15', token: 'token' }))
      .rejects.toThrow('Dispatch bridge unavailable');
  });
});
