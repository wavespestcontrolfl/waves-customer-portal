// @vitest-environment jsdom

// Waves Admin (the iOS staff app) gets staff alerts as iPhone notifications:
// the signed-in page asks the app for its APNs token and registers it under
// its own sign-in, and hands the app the icon badge count.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/adminFetch', () => ({ adminFetch: vi.fn(async () => ({ ok: true })) }));

import { adminFetch } from '../lib/adminFetch';
import { registerInAppPush, releaseInAppPush, setInAppBadge } from './wavesAdminPush';

const TOKEN = 'ab'.repeat(32);

function installApp() {
  const postMessage = vi.fn();
  window.webkit = { messageHandlers: { wavesAdmin: { postMessage } } };
  return postMessage;
}

function answer(detail) {
  window.dispatchEvent(new CustomEvent('wavesadmin:pushtoken', { detail }));
}

afterEach(() => {
  delete window.webkit;
  localStorage.clear();
  vi.clearAllMocks();
});

describe('registerInAppPush', () => {
  it('does nothing in a browser', () => {
    const cleanup = registerInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    expect(adminFetch).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it('asks the app for its token and registers it under the page sign-in until cleanup', () => {
    const postMessage = installApp();
    const cleanup = registerInAppPush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'registerPush' });

    answer({ token: TOKEN, environment: 'sandbox' });
    expect(adminFetch).toHaveBeenCalledWith('/admin/push/native-subscribe', {
      method: 'POST', body: { token: TOKEN, environment: 'sandbox' },
    });

    cleanup();
    answer({ token: TOKEN, environment: 'sandbox' });
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer without a token', () => {
    installApp();
    const cleanup = registerInAppPush();
    answer({ environment: 'sandbox' });
    expect(adminFetch).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('setInAppBadge', () => {
  it('leaves a browser to the Badging API', () => {
    expect(setInAppBadge(4)).toBe(false);
  });

  it('hands the app the count, and zero for anything that is not a count', () => {
    const postMessage = installApp();
    expect(setInAppBadge(4)).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'badge', count: 4 });
    setInAppBadge(-2);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'badge', count: 0 });
  });
});

describe('releaseInAppPush (sign-out)', () => {
  it('stops alerts on the iPhone, waits for a sign-up in flight, then releases the token under the sign-in', async () => {
    const postMessage = installApp();
    localStorage.setItem('waves_admin_token', 'staff-jwt');
    let finishSignUp;
    adminFetch.mockImplementationOnce(() => new Promise((resolve) => { finishSignUp = resolve; }));
    const cleanup = registerInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });

    const released = releaseInAppPush();
    localStorage.removeItem('waves_admin_token'); // sign-out goes on at once
    expect(postMessage).toHaveBeenCalledWith({ type: 'signOut' });
    expect(adminFetch).toHaveBeenCalledTimes(1); // only the sign-up so far

    finishSignUp({ ok: true });
    await released;
    expect(adminFetch).toHaveBeenLastCalledWith('/admin/push/native-unsubscribe', {
      method: 'POST',
      body: { token: TOKEN },
      headers: { Authorization: 'Bearer staff-jwt' },
    });
    expect(localStorage.getItem('waves_admin_push_token')).toBeNull();
    cleanup();
  });

  it('releases the stored token after a page reload, and retries a failed release', async () => {
    vi.useFakeTimers();
    try {
      installApp();
      // A reload: this page never saw the token event, but the token is stored.
      localStorage.setItem('waves_admin_push_token', TOKEN);
      localStorage.setItem('waves_admin_token', 'staff-jwt');
      adminFetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true });

      const released = releaseInAppPush();
      await vi.advanceTimersByTimeAsync(2000);
      await released;
      expect(adminFetch).toHaveBeenCalledTimes(2);
      expect(adminFetch).toHaveBeenLastCalledWith('/admin/push/native-unsubscribe', expect.objectContaining({ body: { token: TOKEN } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a token that arrives after sign-out', async () => {
    installApp();
    const cleanup = registerInAppPush();
    await releaseInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    expect(adminFetch).not.toHaveBeenCalled();
    cleanup();
  });

  it('only stops alerts on the iPhone when it never signed up, and does nothing in a browser', async () => {
    await releaseInAppPush();
    const postMessage = installApp();
    await releaseInAppPush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'signOut' });
    expect(adminFetch).not.toHaveBeenCalled();
  });
});
