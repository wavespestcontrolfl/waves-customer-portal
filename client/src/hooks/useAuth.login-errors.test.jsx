// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './useAuth';

vi.mock('../utils/api', () => ({
  default: {
    token: null,
    refreshToken: null,
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
    getMe: vi.fn(),
    getAuthProperties: vi.fn(async () => ({ properties: [] })),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
    selectAuthProperty: vi.fn(),
  },
}));

vi.mock('../native/nativePush', () => ({
  deactivateNativePushToken: vi.fn(async () => {}),
  flushNativePushToken: vi.fn(async () => {}),
  repostNativePushToken: vi.fn(async () => {}),
}));

import api from '../utils/api';

let authApi;
function Probe() {
  authApi = useAuth();
  return <div data-testid="auth-error">{authApi.error || ''}</div>;
}

function requestError(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

// jsdom in this runner ships without a usable localStorage (same workaround
// as ReportViewPage.render.test.jsx) — stub a functional one per test.
function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

beforeEach(() => {
  stubLocalStorage();
  render(<AuthProvider><Probe /></AuthProvider>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function sendCodeRejectingWith(err) {
  api.sendCode.mockRejectedValueOnce(err);
  await act(async () => { await authApi.sendCode('9415551234'); });
  return screen.getByTestId('auth-error').textContent;
}

describe('login OTP error copy (F-059, login half)', () => {
  it('passes intentional server copy through verbatim', async () => {
    expect(await sendCodeRejectingWith(
      requestError('No account found for this phone number', 404),
    )).toBe('No account found for this phone number');

    expect(await sendCodeRejectingWith(
      requestError('Too many requests. Please try again later.', 429),
    )).toBe('Too many requests. Please try again later.');
  });

  it('never surfaces "Request failed (NNN)" / "HTTP NNN" fallbacks verbatim', async () => {
    const generic = 'Something went wrong. Please try again in a moment.';

    expect(await sendCodeRejectingWith(
      requestError('Request failed (502)', 502),
    )).toBe(generic);

    expect(await sendCodeRejectingWith(
      requestError('HTTP 502', 502),
    )).toBe(generic);
  });

  it('never surfaces proxy/HTML error bodies verbatim', async () => {
    expect(await sendCodeRejectingWith(
      requestError('<html><body>Bad Gateway</body></html>', 502),
    )).toBe('Something went wrong. Please try again in a moment.');

    // A rate-limited proxy body still gets the curated 429 copy.
    expect(await sendCodeRejectingWith(
      requestError('<html>rate limited</html>', 429),
    )).toBe('Too many attempts. Please wait a few minutes and try again.');
  });

  it('applies the same mapping to verifyCode', async () => {
    api.verifyCode.mockRejectedValueOnce(requestError('Request failed (500)', 500));
    await act(async () => { await authApi.verifyCode('9415551234', '123456'); });
    expect(screen.getByTestId('auth-error').textContent)
      .toBe('Something went wrong. Please try again in a moment.');

    api.verifyCode.mockRejectedValueOnce(
      requestError('Invalid or expired verification code', 401),
    );
    await act(async () => { await authApi.verifyCode('9415551234', '123456'); });
    expect(screen.getByTestId('auth-error').textContent)
      .toBe('Invalid or expired verification code');
  });
});
