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
    adoptTokens: vi.fn(function adoptTokens(token, refreshToken) {
      this.token = token;
      this.refreshToken = refreshToken;
    }),
    clearTokens: vi.fn(),
    selectAuthProperty: vi.fn(),
    request: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock('../native/nativePush', () => ({
  deactivateNativePushToken: vi.fn(async () => {}),
  flushNativePushToken: vi.fn(async () => {}),
  repostNativePushToken: vi.fn(async () => {}),
}));

import api from '../utils/api';
import { deactivateNativePushToken } from '../native/nativePush';

let authApi;
function Probe() {
  authApi = useAuth();
  return (
    <>
      <div data-testid="auth-error">{authApi.error || ''}</div>
      <div data-testid="properties-error">{authApi.propertiesError || ''}</div>
      <div data-testid="properties-count">{authApi.properties.length}</div>
      <div data-testid="customer-id">{authApi.customer?.id || ''}</div>
    </>
  );
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
  api.token = null;
  api.refreshToken = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('exposes a way for login navigation to clear stale OTP errors', async () => {
    await sendCodeRejectingWith(requestError('Invalid or expired verification code', 401));
    expect(screen.getByTestId('auth-error')).not.toBeEmptyDOMElement();

    act(() => { authApi.clearError(); });

    expect(screen.getByTestId('auth-error')).toBeEmptyDOMElement();
  });
});

describe('multi-property partial failures', () => {
  it('preserves the known property list and exposes a focused retry', async () => {
    api.getMe.mockResolvedValue({ id: 'cust-1', firstName: 'Pat' });
    api.getAuthProperties.mockResolvedValueOnce({ properties: [{ id: 'cust-1' }, { id: 'cust-2' }] });

    await act(async () => { await authApi.refreshCustomer(); });
    expect(screen.getByTestId('properties-count')).toHaveTextContent('2');

    api.getAuthProperties.mockRejectedValueOnce(requestError('Request failed (503)', 503));
    await act(async () => { await authApi.refreshCustomer(); });

    expect(screen.getByTestId('properties-count')).toHaveTextContent('2');
    expect(screen.getByTestId('properties-error')).toHaveTextContent('temporarily unavailable');

    api.getAuthProperties.mockResolvedValueOnce({ properties: [{ id: 'cust-1' }, { id: 'cust-2' }] });
    await act(async () => { await authApi.refreshProperties(); });
    expect(screen.getByTestId('properties-error')).toBeEmptyDOMElement();
  });
});

describe('logout', () => {
  it('clears the visible session immediately while server and native cleanup continue', async () => {
    api.getMe.mockResolvedValue({ id: 'cust-1', firstName: 'Pat' });
    api.getAuthProperties.mockResolvedValue({ properties: [{ id: 'cust-1' }] });
    await act(async () => { await authApi.refreshCustomer(); });
    expect(screen.getByTestId('customer-id')).toHaveTextContent('cust-1');

    localStorage.setItem('waves_refresh_token', 'refresh-1');
    api.refreshToken = 'refresh-1';
    let finishPush;
    deactivateNativePushToken.mockReturnValueOnce(new Promise((resolve) => { finishPush = resolve; }));
    api.request.mockReturnValueOnce(new Promise(() => {}));

    act(() => { authApi.logout(); });

    expect(screen.getByTestId('customer-id')).toBeEmptyDOMElement();
    expect(api.clearTokens).not.toHaveBeenCalled();
    expect(api.request).not.toHaveBeenCalled();

    await act(async () => { finishPush(); });

    expect(api.clearTokens).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenLastCalledWith('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'refresh-1' }),
    });
  });
});
