// @vitest-environment jsdom
// Session-epoch guards: async auth responses that started under a previous
// session identity must be DISCARDED, not applied. Regressions covered:
// (1) a delayed /auth/select-property response re-writing tokens after Sign
// out (walking a signed-out user back into the portal), and (2) a slow
// /auth/me last-response-wins painting a previous property's identity over
// the one the current token authenticates.
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
    setTokens: vi.fn(function setTokens(token, refreshToken) {
      this.token = token;
      this.refreshToken = refreshToken;
    }),
    adoptTokens: vi.fn(function adoptTokens(token, refreshToken) {
      this.token = token;
      this.refreshToken = refreshToken;
    }),
    clearTokens: vi.fn(function clearTokens() {
      this.token = null;
      this.refreshToken = null;
    }),
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

let authApi;
function Probe() {
  authApi = useAuth();
  return (
    <>
      <div data-testid="customer-id">{authApi.customer?.id || ''}</div>
      <div data-testid="authed">{String(authApi.isAuthenticated)}</div>
    </>
  );
}

function stubLocalStorage(store = {}) {
  vi.stubGlobal('localStorage', {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  });
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.token = null;
  api.refreshToken = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('session epoch guards', () => {
  it('discards a property-switch response that lands after Sign out', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    api.getMe.mockResolvedValueOnce({ id: 'cust-a' });
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-a');

    const slowSwitch = deferred();
    api.selectAuthProperty.mockReturnValueOnce(slowSwitch.promise);

    let switchResult;
    await act(async () => {
      const pending = authApi.switchProperty('cust-b');
      // Sign out while the switch response is still in flight...
      authApi.logout();
      // ...then the delayed response arrives with fresh-looking tokens.
      slowSwitch.resolve({ token: 'tok-b', refreshToken: 'ref-b', properties: [] });
      switchResult = await pending;
    });

    expect(switchResult).toBe(false);
    // The zombie tokens must never be adopted and the portal must stay
    // signed out.
    expect(api.setTokens).not.toHaveBeenCalledWith('tok-b', 'ref-b');
    expect(screen.getByTestId('authed').textContent).toBe('false');
    expect(screen.getByTestId('customer-id').textContent).toBe('');
  });

  it('discards a slow /auth/me response from before a property switch', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    const slowMe = deferred();
    // Mount-time load under property A stalls...
    api.getMe.mockReturnValueOnce(slowMe.promise);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    // ...the customer switches to property B, which loads fast...
    api.selectAuthProperty.mockResolvedValueOnce({ token: 'tok-b', refreshToken: 'ref-b', properties: [] });
    api.getMe.mockResolvedValueOnce({ id: 'cust-b' });
    await act(async () => { await authApi.switchProperty('cust-b'); });
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-b');

    // ...and the stalled property-A response finally lands. Last-response-
    // wins would repaint identity A while every request authenticates as B.
    await act(async () => { slowMe.resolve({ id: 'cust-a' }); });
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-b');
  });

  it('does NOT supersede an in-flight switch on a same-customer token rotation from another tab', async () => {
    const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tokenFor = (customerId, nonce) => `${b64u({ alg: 'none' })}.${b64u({ customerId, nonce })}.x`;
    const tokA1 = tokenFor('cust-a', 1);
    const tokA2 = tokenFor('cust-a', 2);
    const store = { waves_token: tokA1, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    api.getMe.mockResolvedValueOnce({ id: 'cust-a' });
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    const slowSwitch = deferred();
    api.selectAuthProperty.mockReturnValueOnce(slowSwitch.promise);
    api.getMe.mockResolvedValue({ id: 'cust-b' });

    let switchResult;
    await act(async () => {
      const pending = authApi.switchProperty('cust-b');
      // Another tab rotates the SAME customer's access token mid-switch —
      // identity unchanged, so this must not invalidate the switch.
      store.waves_token = tokA2;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: tokA2 }));
      slowSwitch.resolve({ token: 'tok-b', refreshToken: 'ref-b', properties: [] });
      switchResult = await pending;
    });

    expect(switchResult).toBe(true);
    expect(api.setTokens).toHaveBeenCalledWith('tok-b', 'ref-b');
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-b');
  });

  it('does NOT supersede on a legacy token\'s sessionId-upgrading refresh from another tab', async () => {
    const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const legacyTok = `${b64u({ alg: 'none' })}.${b64u({ customerId: 'cust-a' })}.x`;
    const upgradedTok = `${b64u({ alg: 'none' })}.${b64u({ customerId: 'cust-a', sessionId: 'sess-9' })}.x`;
    const store = { waves_token: legacyTok, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    api.getMe.mockResolvedValueOnce({ id: 'cust-a' });
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    const slowSwitch = deferred();
    api.selectAuthProperty.mockReturnValueOnce(slowSwitch.promise);
    api.getMe.mockResolvedValue({ id: 'cust-b' });

    let switchResult;
    await act(async () => {
      const pending = authApi.switchProperty('cust-b');
      // Another tab's routine refresh upgrades the legacy token into a
      // durable session family — same session, not a new login.
      store.waves_token = upgradedTok;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: upgradedTok }));
      slowSwitch.resolve({ token: 'tok-b', refreshToken: 'ref-b', properties: [] });
      switchResult = await pending;
    });

    expect(switchResult).toBe(true);
    expect(api.setTokens).toHaveBeenCalledWith('tok-b', 'ref-b');
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-b');
  });

  it('DOES supersede on a same-customer NEW-session login from another tab (family change)', async () => {
    const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tokenFor = (customerId, sessionId) => `${b64u({ alg: 'none' })}.${b64u({ customerId, sessionId })}.x`;
    const tokOldSession = tokenFor('cust-a', 'sess-1');
    const tokNewSession = tokenFor('cust-a', 'sess-2');
    const store = { waves_token: tokOldSession, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    const slowMe = deferred();
    // Mount-time load under the OLD session stalls...
    api.getMe.mockReturnValueOnce(slowMe.promise);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    // ...another tab completes a FRESH code login for the same customer
    // (new session family)...
    api.getMe.mockResolvedValue({ id: 'cust-a' });
    await act(async () => {
      store.waves_token = tokNewSession;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: tokNewSession }));
    });

    // ...and the OLD session's stalled /auth/me finally fails 401. It must
    // not clear the newly adopted family's credentials.
    const staleAuthErr = new Error('Invalid token');
    staleAuthErr.status = 401;
    await act(async () => { slowMe.reject(staleAuthErr); });

    expect(api.clearTokens).not.toHaveBeenCalled();
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-a');
  });

  it('ignores a stale 401 from a replaced token instead of clearing the new session', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    const slowMe = deferred();
    api.getMe.mockReturnValueOnce(slowMe.promise);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    api.selectAuthProperty.mockResolvedValueOnce({ token: 'tok-b', refreshToken: 'ref-b', properties: [] });
    api.getMe.mockResolvedValueOnce({ id: 'cust-b' });
    await act(async () => { await authApi.switchProperty('cust-b'); });

    const staleAuthErr = new Error('Invalid token');
    staleAuthErr.status = 401;
    await act(async () => { slowMe.reject(staleAuthErr); });

    expect(api.clearTokens).not.toHaveBeenCalled();
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-b');
  });
});
