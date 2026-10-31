// @vitest-environment jsdom

// Waves Admin (the iOS staff app) gets staff alerts as iPhone notifications:
// the signed-in page asks the app for its APNs token and registers it under
// its own sign-in, hands the app the icon badge count, and releases the
// sign-up again at sign-out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/adminFetch', () => ({ adminFetch: vi.fn(async () => ({ ok: true, status: 200 })) }));

import { adminFetch } from '../lib/adminFetch';
import { registerInAppPush, releaseInAppPush, setInAppBadge } from './wavesAdminPush';

const TOKEN = 'ab'.repeat(32);
const SIGN_UP_KEY = 'waves_admin_push_signup';

function installApp() {
  const postMessage = vi.fn();
  window.webkit = { messageHandlers: { wavesAdmin: { postMessage } } };
  return postMessage;
}

function answer(detail) {
  window.dispatchEvent(new CustomEvent('wavesadmin:pushtoken', { detail }));
}

const storedSignUp = () => JSON.parse(localStorage.getItem(SIGN_UP_KEY) || 'null');

beforeEach(() => {
  adminFetch.mockImplementation(async () => ({ ok: true, status: 200 }));
});

afterEach(async () => {
  // Ends any sign-up retry from the test and settles the shared queue.
  vi.useRealTimers();
  if (!window.webkit) installApp();
  localStorage.removeItem(SIGN_UP_KEY);
  await releaseInAppPush();
  delete window.webkit;
  localStorage.clear();
  vi.clearAllMocks();
});

describe('registerInAppPush', () => {
  it('does nothing in a browser', () => {
    delete window.webkit;
    const cleanup = registerInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    expect(adminFetch).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it('asks the app for its token and registers it, with its own sign-up id, under the page sign-in', async () => {
    const postMessage = installApp();
    const cleanup = registerInAppPush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'registerPush' });

    answer({ token: TOKEN, environment: 'sandbox' });
    await vi.waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    const { reg } = storedSignUp();
    expect(reg).toEqual(expect.any(String));
    expect(adminFetch).toHaveBeenCalledWith('/admin/push/native-subscribe', {
      method: 'POST', body: { token: TOKEN, environment: 'sandbox', reg },
    });

    cleanup();
    answer({ token: TOKEN, environment: 'sandbox' });
    await Promise.resolve();
    expect(adminFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a failed sign-up when the connection comes back, and stops on a refusal', async () => {
    vi.useFakeTimers();
    installApp();
    adminFetch
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ ok: false, status: 401 });
    const cleanup = registerInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    await vi.advanceTimersByTimeAsync(0);
    expect(adminFetch).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(adminFetch).toHaveBeenCalledTimes(2);

    // 401: the sign-in ended; no more tries.
    await vi.advanceTimersByTimeAsync(120000);
    expect(adminFetch).toHaveBeenCalledTimes(2);
    cleanup();
  });
});

describe('releaseInAppPush (sign-out)', () => {
  it('stops alerts on the iPhone, then releases this sign-up after the one in flight lands', async () => {
    const postMessage = installApp();
    localStorage.setItem('waves_admin_token', 'staff-jwt');
    let finishSignUp;
    adminFetch.mockImplementationOnce(() => new Promise((resolve) => { finishSignUp = resolve; }));
    const cleanup = registerInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    await vi.waitFor(() => expect(adminFetch).toHaveBeenCalledTimes(1));
    const { reg } = storedSignUp();

    const released = releaseInAppPush();
    localStorage.removeItem('waves_admin_token'); // sign-out goes on at once
    expect(postMessage).toHaveBeenCalledWith({ type: 'signOut' });
    expect(storedSignUp()).toBeNull();
    await Promise.resolve();
    expect(adminFetch).toHaveBeenCalledTimes(1); // the release waits

    finishSignUp({ ok: true, status: 200 });
    await released;
    expect(adminFetch).toHaveBeenLastCalledWith('/admin/push/native-unsubscribe', {
      method: 'POST',
      body: { token: TOKEN, reg },
      headers: { Authorization: 'Bearer staff-jwt' },
    });
    cleanup();
  });

  it('releases the stored sign-up after a page reload, and retries a failed release', async () => {
    vi.useFakeTimers();
    installApp();
    // A reload: this page never saw the token event, but the sign-up is stored.
    localStorage.setItem(SIGN_UP_KEY, JSON.stringify({ token: TOKEN, reg: 'reg-0001' }));
    localStorage.setItem('waves_admin_token', 'staff-jwt');
    adminFetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, status: 200 });

    const released = releaseInAppPush();
    await vi.advanceTimersByTimeAsync(2000);
    await released;
    expect(adminFetch).toHaveBeenCalledTimes(2);
    expect(adminFetch).toHaveBeenLastCalledWith('/admin/push/native-unsubscribe',
      expect.objectContaining({ body: { token: TOKEN, reg: 'reg-0001' } }));
  });

  it('ignores a token that arrives after sign-out', async () => {
    installApp();
    const cleanup = registerInAppPush();
    await releaseInAppPush();
    answer({ token: TOKEN, environment: 'sandbox' });
    await Promise.resolve();
    expect(adminFetch).not.toHaveBeenCalled();
    cleanup();
  });

  it('only stops alerts on the iPhone when it never signed up', async () => {
    const postMessage = installApp();
    await releaseInAppPush();
    expect(postMessage).toHaveBeenCalledWith({ type: 'signOut' });
    expect(adminFetch).not.toHaveBeenCalled();
  });
});

describe('setInAppBadge', () => {
  it('leaves a browser to the Badging API', () => {
    delete window.webkit;
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
