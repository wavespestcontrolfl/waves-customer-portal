// @vitest-environment jsdom

// Inside the Waves Admin iPhone app the payment runs over the page: the
// launcher hands the signed link to the app's bridge and resolves with the
// app's answer for THIS request — never navigating away, and never taking the
// app-switch return snapshot that only Safari needs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./adminFetch', () => ({ adminFetch: vi.fn() }));
vi.mock('./tapToPayReturn', () => ({ snapshotForHandoff: vi.fn() }));

import { adminFetch } from './adminFetch';
import { snapshotForHandoff } from './tapToPayReturn';
import { launchTapToPay, prepareInAppReader } from './tapToPay';

const DEEP_LINK = 'wavespay://collect?t=header.payload.sig';
// The app's web view keeps the iPhone WebKit user agent and adds WavesAdmin/<version>.
const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WavesAdmin/1.1';

function answer(detail) {
  window.dispatchEvent(new CustomEvent('wavesadmin:taptopay', { detail }));
}

describe('launchTapToPay inside the Waves Admin app', () => {
  let postMessage;

  beforeEach(() => {
    postMessage = vi.fn();
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage } } };
    Object.defineProperty(window.navigator, 'userAgent', { value: APP_UA, configurable: true });
    adminFetch.mockResolvedValue({ ok: true, json: async () => ({ deep_link: DEEP_LINK }) });
  });

  afterEach(() => {
    delete window.webkit;
    delete window.navigator.userAgent;
    vi.clearAllMocks();
  });

  it('hands the minted link to the app and resolves with the answer for its own request', async () => {
    const hrefBefore = window.location.href;
    const pending = launchTapToPay('inv-1');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    expect(adminFetch).toHaveBeenCalledWith('/stripe/terminal/handoff', {
      method: 'POST',
      body: { invoice_id: 'inv-1' },
    });
    const message = postMessage.mock.calls[0][0];
    expect(message).toEqual({ type: 'tapToPay', requestId: expect.any(String), deepLink: DEEP_LINK });

    let settled = false;
    pending.then(() => { settled = true; });
    // Another request's answer is not ours.
    answer({ requestId: 'someone-else', status: 'succeeded', paymentIntentId: 'pi_other' });
    await Promise.resolve();
    expect(settled).toBe(false);

    answer({ requestId: message.requestId, status: 'succeeded', paymentIntentId: 'pi_1' });
    await expect(pending).resolves.toEqual({
      inApp: true,
      status: 'succeeded',
      paymentIntentId: 'pi_1',
      message: null,
    });
    expect(window.location.href).toBe(hrefBefore);
    expect(snapshotForHandoff).not.toHaveBeenCalled();
  });

  it('passes a failure message through to the caller', async () => {
    const pending = launchTapToPay('inv-2');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const { requestId } = postMessage.mock.calls[0][0];

    answer({ requestId, status: 'failed', message: 'The invoice total changed. Close this and tap Tap to Pay again.' });

    await expect(pending).resolves.toEqual({
      inApp: true,
      status: 'failed',
      paymentIntentId: null,
      message: 'The invoice total changed. Close this and tap Tap to Pay again.',
    });
  });
});

// The app connects the card reader before the first tap and asks the signed-in
// page for each Stripe connection token (ios/WavesPay/Sources/PortalView.swift).
describe('prepareInAppReader', () => {
  afterEach(() => {
    delete window.webkit;
    delete window.wavesAdminConnectionToken;
    vi.clearAllMocks();
  });

  it('does nothing in a browser', () => {
    const cleanup = prepareInAppReader();
    expect(window.wavesAdminConnectionToken).toBeUndefined();
    expect(() => cleanup()).not.toThrow();
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it('asks the app to prepare and serves tokens under the page sign-in until cleanup', async () => {
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage } } };
    adminFetch.mockResolvedValue({ ok: true, json: async () => ({ secret: 'pst_test_123' }) });

    const cleanup = prepareInAppReader();
    expect(postMessage).toHaveBeenCalledWith({ type: 'prepareReader' });
    await expect(window.wavesAdminConnectionToken()).resolves.toBe('pst_test_123');
    expect(adminFetch).toHaveBeenCalledWith('/stripe/terminal/connection-token', { method: 'POST' });

    cleanup();
    expect(window.wavesAdminConnectionToken).toBeUndefined();
  });

  it('rejects when the server refuses, so the app falls back to the payment token', async () => {
    window.webkit = { messageHandlers: { wavesAdmin: { postMessage: vi.fn() } } };
    adminFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Token expired' }) });

    prepareInAppReader();
    await expect(window.wavesAdminConnectionToken()).rejects.toThrow('Connection token failed (401)');
  });
});
