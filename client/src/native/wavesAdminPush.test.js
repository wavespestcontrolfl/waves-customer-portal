// @vitest-environment jsdom

// Waves Admin (the iOS staff app) gets staff alerts as iPhone notifications:
// the signed-in page asks the app for its APNs token and registers it under
// its own sign-in, and hands the app the icon badge count.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/adminFetch', () => ({ adminFetch: vi.fn(async () => ({ ok: true })) }));

import { adminFetch } from '../lib/adminFetch';
import { registerInAppPush, setInAppBadge } from './wavesAdminPush';

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
