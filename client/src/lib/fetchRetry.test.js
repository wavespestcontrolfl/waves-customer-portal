import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithNetworkRetry, NETWORK_RETRY_DELAYS_MS } from './fetchRetry';

describe('fetchWithNetworkRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns the response immediately on first success (no timers involved)', async () => {
    const response = { ok: true, json: async () => ({}) };
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithNetworkRetry('/api/pay/t/update-amount', { method: 'POST' })).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on a non-ok HTTP response — only network-layer rejections', async () => {
    const response = { ok: false, status: 400, json: async () => ({ error: 'nope' }) };
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithNetworkRetry('/api/pay/t/update-amount')).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a network rejection and returns the eventual success', async () => {
    const response = { ok: true, json: async () => ({}) };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithNetworkRetry('/api/pay/t/update-amount');
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAYS_MS[0]);
    await expect(promise).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting the retry schedule and rethrows the last error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithNetworkRetry('/api/pay/t/quote');
    const assertion = expect(promise).rejects.toThrow('Load failed');
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1 + NETWORK_RETRY_DELAYS_MS.length);
  });

  it('passes url and options through unchanged on every attempt', async () => {
    const response = { ok: true };
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithNetworkRetry('/api/pay/t/update-amount', options);
    await vi.advanceTimersByTimeAsync(NETWORK_RETRY_DELAYS_MS[0]);
    await promise;
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/pay/t/update-amount', options);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/pay/t/update-amount', options);
  });
});
