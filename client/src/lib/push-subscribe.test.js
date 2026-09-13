// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disablePush } from './push-subscribe.js';

const OPT_IN_KEY = 'waves_push_admin_opt_ins';
const token = `header.${btoa(JSON.stringify({ technicianId: 'admin-1' }))}.signature`;
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');

describe('disablePush', () => {
  let unsubscribe;

  beforeEach(() => {
    localStorage.clear();
    unsubscribe = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({
              endpoint: 'https://push.example/subscription-1',
              unsubscribe,
            }),
          },
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    } else {
      delete navigator.serviceWorker;
    }
    localStorage.clear();
  });

  function expectOptedOut() {
    expect(JSON.parse(localStorage.getItem(OPT_IN_KEY))).toEqual({ 'admin-1': false });
  }

  it('preserves the browser endpoint for retry when the server request rejects', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Network unavailable'));

    await expect(disablePush({ apiBase: '/api', token })).rejects.toThrow(
      'Push could not be fully disabled. The server could not be reached: Network unavailable. Please try again.',
    );

    expect(unsubscribe).not.toHaveBeenCalled();
    expectOptedOut();
  });

  it('preserves the browser endpoint after an unsuccessful server response', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ error: 'Temporarily unavailable' }),
    });

    await expect(disablePush({ apiBase: '/api', token })).rejects.toThrow(
      'Push could not be fully disabled. The server rejected the request (HTTP 503). Please try again.',
    );

    expect(unsubscribe).not.toHaveBeenCalled();
    expectOptedOut();
  });

  it('retries server cleanup with the same endpoint after a network failure', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Offline'));
    await expect(disablePush({ token })).rejects.toThrow('Offline');
    expect(unsubscribe).not.toHaveBeenCalled();

    await expect(disablePush({ token })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expectOptedOut();
  });

  it('rejects when the browser reports that unsubscribe did not succeed', async () => {
    unsubscribe.mockResolvedValueOnce(false);

    await expect(disablePush({ apiBase: '/api', token })).rejects.toThrow(
      'The browser did not confirm that its subscription was removed.',
    );

    expect(fetch).toHaveBeenCalledOnce();
    expectOptedOut();
  });

  it('rejects when browser unsubscribe throws', async () => {
    unsubscribe.mockRejectedValueOnce(new Error('Permission denied'));

    await expect(disablePush({ apiBase: '/api', token })).rejects.toThrow(
      'The browser could not remove its subscription: Permission denied',
    );

    expect(fetch).toHaveBeenCalledOnce();
    expectOptedOut();
  });

  it('succeeds without a server request when no browser subscription exists', async () => {
    navigator.serviceWorker.getRegistration.mockResolvedValueOnce({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
    });

    await expect(disablePush({ apiBase: '/api', token })).resolves.toEqual({ ok: true });

    expect(fetch).not.toHaveBeenCalled();
    expectOptedOut();
  });

  it('returns success only after both server and browser cleanup succeed', async () => {
    fetch.mockImplementationOnce(async () => {
      expectOptedOut();
      return { ok: true, status: 200 };
    });

    await expect(disablePush({ apiBase: '/custom-api', token })).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith('/custom-api/admin/push/unsubscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ endpoint: 'https://push.example/subscription-1' }),
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expectOptedOut();
  });
});
