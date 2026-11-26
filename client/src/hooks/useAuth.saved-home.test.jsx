// @vitest-environment jsdom
// Saved home screen (owner 2026-11-25): a launch with a saved login paints the
// last saved account at once (no money), then /auth/me replaces it. Pins the
// adopt / replace / keep / delete rules and every path that deletes it.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './useAuth';
import { HOME_READS_KEY, HOME_SNAPSHOT_KEY, HOME_STORE_MAX_AGE_MS, homeIdentityKey, writeHomeRead, writeHomeSnapshot } from '../lib/homeSnapshot';

vi.mock('../native/nativeBadge', () => ({ clearNativeBadge: vi.fn() }));
vi.mock('../native/visitCard', () => ({ endVisitCards: vi.fn() }));
vi.mock('../native/nativePush', () => ({
  deactivateNativePushToken: vi.fn(async () => {}),
  flushNativePushToken: vi.fn(async () => {}),
  repostNativePushToken: vi.fn(async () => {}),
}));
vi.mock('../utils/api', () => ({
  default: {
    token: null,
    refreshToken: null,
    getMe: vi.fn(),
    getAuthProperties: vi.fn(),
    selectAuthProperty: vi.fn(),
    verifyCode: vi.fn(),
    setTokens: vi.fn(function setTokens(token, refreshToken) { this.token = token; this.refreshToken = refreshToken; }),
    adoptTokens: vi.fn(function adoptTokens(token, refreshToken) { this.token = token; this.refreshToken = refreshToken; }),
    clearTokens: vi.fn(function clearTokens() { this.token = null; this.refreshToken = null; localStorage.removeItem('waves_token'); }),
    request: vi.fn(async () => ({ success: true })),
  },
}));

import api from '../utils/api';

const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (claims, tail = 'sig') => `${b64u({ alg: 'none' })}.${b64u(claims)}.${tail}`;
const TOKEN = makeToken({ customerId: 'cust-1', sessionId: 'fam-1' });

const FRESH_ME = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Fresh', tier: 'Silver', actor: { kind: 'holder' },
  monthlyRate: 89, accountCredit: 45, autoApplyAccountCredit: true, credits: [{ amount: 25 }], annualPrepay: null,
  cancelled: false, propertyScope: { enabled: false },
};
const PROPS = {
  scope: 'saved',
  properties: [{ key: 'cust-1:p1', customerId: 'cust-1', propertyId: 'p1', isPrimaryProperty: true, isPrimaryProfile: true, profileLabel: 'Primary', address: { line1: '1 Test Way' } }],
  selected: { key: 'cust-1:p1', customerId: 'cust-1', propertyId: 'p1' },
};

let authApi;
function Probe() {
  authApi = useAuth();
  return (
    <>
      <div data-testid="name">{authApi.customer ? `${authApi.customer.firstName} ${authApi.customer.lastName}` : ''}</div>
      <div data-testid="saved">{String(authApi.customerSaved)}</div>
      <div data-testid="loading">{String(authApi.loading)}</div>
      <div data-testid="rate">{String(authApi.customer?.monthlyRate)}</div>
      <div data-testid="selected">{authApi.selectedProperty?.key || ''}</div>
    </>
  );
}
const mount = async () => { await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); }); };
const savedSnapshot = () => localStorage.getItem(HOME_SNAPSHOT_KEY);
const seedSnapshot = (token = TOKEN, me = { ...FRESH_ME, lastName: 'Saved' }) => {
  localStorage.setItem('waves_token', token);
  return writeHomeSnapshot({ token, requestIdentity: homeIdentityKey(token), me, propertyPayload: PROPS });
};
const pendingForever = () => api.getMe.mockImplementation(() => new Promise(() => {}));
const text = (id) => screen.getByTestId(id).textContent;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.clear();
  api.token = null;
  api.refreshToken = null;
  api.getMe.mockReset();
  api.getAuthProperties.mockReset().mockResolvedValue(PROPS);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('saved home screen at launch', () => {
  it('paints the saved account at once with no money, then replaces it with the fresh account', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    let release;
    api.getMe.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await mount();
    expect(text('name')).toBe('Pat Saved');
    expect(text('saved')).toBe('true');
    expect(text('loading')).toBe('false');
    expect(authApi.isAuthenticated).toBe(true);
    expect(text('rate')).toBe('undefined');
    expect(authApi.customer.accountCredit).toBeUndefined();
    expect(authApi.customer.annualPrepay).toBeUndefined();
    expect(text('selected')).toBe('cust-1:p1');
    expect(authApi.properties).toHaveLength(1);
    await act(async () => { release(FRESH_ME); });
    expect(text('name')).toBe('Pat Fresh');
    expect(text('saved')).toBe('false');
    expect(text('rate')).toBe('89');
  });

  it('a successful load writes the snapshot without money', async () => {
    localStorage.setItem('waves_token', TOKEN);
    api.getMe.mockResolvedValue(FRESH_ME);
    await mount();
    const raw = savedSnapshot();
    expect(raw).toContain('Fresh');
    for (const word of ['monthlyRate', 'accountCredit', 'autoApplyAccountCredit', 'credits', 'annualPrepay']) expect(raw).not.toContain(word);
  });

  it.each([
    ['another customer', () => makeToken({ customerId: 'cust-2', sessionId: 'fam-1' })],
    ['a new login (another session family)', () => makeToken({ customerId: 'cust-1', sessionId: 'fam-2' })],
    ['another property', () => makeToken({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'p2' })],
    ['a contact session', () => makeToken({ customerId: 'cust-1', sessionId: 'fam-1', contactKey: '9415550000' })],
    ['a token with no session family', () => makeToken({ customerId: 'cust-1' })],
  ])('never adopts a snapshot saved for %s', async (_label, tokenFor) => {
    seedSnapshot();
    localStorage.setItem('waves_token', tokenFor());
    pendingForever();
    await mount();
    expect(text('name')).toBe('');
    expect(text('saved')).toBe('false');
    expect(text('loading')).toBe('true');
  });

  it('never adopts an expired or wrong-version snapshot, and deletes it', async () => {
    seedSnapshot();
    const entry = JSON.parse(savedSnapshot());
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, savedAt: Date.now() - HOME_STORE_MAX_AGE_MS - 5000 }));
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    expect(text('saved')).toBe('false');
    expect(savedSnapshot()).toBeNull();
    cleanup();
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, v: 99 }));
    await mount();
    expect(text('saved')).toBe('false');
    expect(savedSnapshot()).toBeNull();
  });

  it('never adopts a cancelled-account snapshot', async () => {
    seedSnapshot();
    const entry = JSON.parse(savedSnapshot());
    localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify({ ...entry, customer: { ...entry.customer, cancelled: true } }));
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    expect(text('saved')).toBe('false');
  });

  it('a 401 deletes the snapshot and signs out', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    api.getMe.mockRejectedValue(Object.assign(new Error('expired'), { status: 401 }));
    await mount();
    expect(api.clearTokens).toHaveBeenCalled();
    expect(savedSnapshot()).toBeNull();
    expect(text('name')).toBe('');
    expect(text('saved')).toBe('false');
    expect(authApi.isAuthenticated).toBe(false);
  });

  it('a 403 deletes the snapshot on its own, even when the token helper does nothing', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    api.clearTokens.mockImplementationOnce(() => {});
    api.getMe.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await mount();
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
  });

  it('a transient failure keeps the saved screen, keeps the snapshot and retries', async () => {
    vi.useFakeTimers();
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    api.getMe.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(FRESH_ME);
    await mount();
    expect(text('name')).toBe('Pat Saved');
    expect(text('saved')).toBe('true');
    expect(text('loading')).toBe('false');
    expect(savedSnapshot()).not.toBeNull();
    expect(api.clearTokens).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(api.getMe).toHaveBeenCalledTimes(2);
    expect(text('name')).toBe('Pat Fresh');
    expect(text('saved')).toBe('false');
  });

  it('a fresh cancelled account deletes the saved snapshot', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    api.getMe.mockResolvedValue({ ...FRESH_ME, cancelled: true });
    await mount();
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
  });

  it('logout deletes the snapshot at once, before the native cleanup finishes', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    const { deactivateNativePushToken } = await import('../native/nativePush');
    let release;
    deactivateNativePushToken.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    await act(async () => { authApi.logout(); });
    expect(api.clearTokens).not.toHaveBeenCalled();
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
    expect(text('name')).toBe('');
    await act(async () => { release(); });
  });

  it('another tab signing out deletes it and ends the saved screen', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    expect(text('saved')).toBe('true');
    await act(async () => {
      localStorage.removeItem('waves_token');
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token' }));
    });
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
    expect(text('name')).toBe('');
  });

  it('another tab adopting a different property deletes it and clears the screen', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    await act(async () => {
      localStorage.setItem('waves_token', makeToken({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'p2' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token' }));
    });
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
    expect(text('name')).toBe('');
  });

  it('another tab rotating the same session keeps the saved screen', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    await act(async () => {
      localStorage.setItem('waves_token', makeToken({ customerId: 'cust-1', sessionId: 'fam-1' }, 'rotated'));
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token' }));
    });
    expect(savedSnapshot()).not.toBeNull();
    expect(text('saved')).toBe('true');
  });

  it('a property switch deletes the snapshot and drops the saved screen', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    api.selectAuthProperty.mockResolvedValue({
      token: makeToken({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'p2' }),
      refreshToken: 'r',
      selected: { customerId: 'cust-1', propertyId: 'p2' },
    });
    await act(async () => { void authApi.switchProperty({ customerId: 'cust-1', propertyId: 'p2' }); });
    expect(savedSnapshot()).toBeNull();
    expect(text('saved')).toBe('false');
  });

  it('a load that was in flight when the identity changed paints nothing over the new identity', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    let release;
    api.getMe.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await mount();
    pendingForever();
    await act(async () => {
      localStorage.setItem('waves_token', makeToken({ customerId: 'cust-2', sessionId: 'fam-5' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token' }));
    });
    await act(async () => { release(FRESH_ME); });
    expect(text('name')).toBe('');
    expect(savedSnapshot()).toBeNull();
  });

  it('a profile that answers after another login took the token saves nothing under the new identity', async () => {
    localStorage.setItem('waves_token', TOKEN);
    let release;
    api.getMe.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await mount();
    // A token refresh adopted another tab's new login; no storage event reached the handler.
    const other = makeToken({ customerId: 'cust-1', sessionId: 'fam-7' });
    localStorage.setItem('waves_token', other);
    api.token = other;
    await act(async () => { release({ ...FRESH_ME, firstName: 'Customer', lastName: 'A' }); });
    expect(savedSnapshot()).toBeNull();
  });

  it('a same-customer new session family drops the saved screen and waits, even when the new load stalls', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    pendingForever();
    await mount();
    expect(text('saved')).toBe('true');
    await act(async () => {
      localStorage.setItem('waves_token', makeToken({ customerId: 'cust-1', sessionId: 'fam-2' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token' }));
    });
    expect(text('name')).toBe('');
    expect(text('saved')).toBe('false');
    expect(text('loading')).toBe('true');
    expect(authApi.properties).toHaveLength(0);
  });

  it('a fresh cancelled account also deletes the saved home reads', async () => {
    seedSnapshot();
    writeHomeRead(homeIdentityKey(TOKEN), 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    expect(localStorage.getItem(HOME_READS_KEY)).not.toBeNull();
    api.getMe.mockResolvedValue({ ...FRESH_ME, cancelled: true });
    await mount();
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
    expect(savedSnapshot()).toBeNull();
  });

  it('a fresh contact account deletes the saved home reads too', async () => {
    seedSnapshot();
    writeHomeRead(homeIdentityKey(TOKEN), 'cust-1:p1', 'next-visit', { next: null }, Date.now());
    api.getMe.mockResolvedValue({ ...FRESH_ME, actor: { kind: 'contact', slot: 1 } });
    await mount();
    expect(localStorage.getItem(HOME_READS_KEY)).toBeNull();
  });

  it('a /auth/me answer for a replaced login never unlocks the saved screen, and loads again under the current login', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    let releaseOld;
    api.getMe.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    await mount();
    expect(text('saved')).toBe('true');
    // A token refresh adopted another tab's login (a different customer) before any storage event.
    const other = makeToken({ customerId: 'cust-2', sessionId: 'fam-7' });
    localStorage.setItem('waves_token', other);
    api.token = other;
    api.getMe.mockImplementation(() => new Promise(() => {}));
    // The old login's property list would never answer: the profile alone must not be published.
    api.getAuthProperties.mockImplementation(() => new Promise(() => {}));
    await act(async () => { releaseOld({ ...FRESH_ME, lastName: 'OldLogin' }); });
    expect(text('name')).toBe('');
    expect(text('saved')).toBe('false');
    expect(text('loading')).toBe('true');
    expect(authApi.isAuthenticated).toBe(false);
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });

  it('a property list that answers for a replaced login is discarded and the load restarts', async () => {
    localStorage.setItem('waves_token', TOKEN);
    let releaseList;
    api.getMe.mockResolvedValueOnce(FRESH_ME);
    api.getAuthProperties.mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve; }));
    await mount();
    expect(text('name')).toBe('Pat Fresh');
    const other = makeToken({ customerId: 'cust-1', sessionId: 'fam-8' });
    localStorage.setItem('waves_token', other);
    api.token = other;
    api.getMe.mockImplementation(() => new Promise(() => {}));
    await act(async () => { releaseList(PROPS); });
    expect(text('name')).toBe('');
    expect(text('loading')).toBe('true');
    expect(authApi.properties).toHaveLength(0);
    expect(savedSnapshot()).toBeNull();
  });

  it('a 401 for a replaced login does not sign out the current login', async () => {
    localStorage.setItem('waves_token', TOKEN);
    let rejectOld;
    api.getMe.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    await mount();
    const other = makeToken({ customerId: 'cust-2', sessionId: 'fam-7' });
    localStorage.setItem('waves_token', other);
    api.token = other;
    api.getMe.mockImplementation(() => new Promise(() => {}));
    await act(async () => { rejectOld(Object.assign(new Error('expired'), { status: 401 })); });
    expect(api.clearTokens).not.toHaveBeenCalled();
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });

  it('keeps the saved screen (and the held tabs) until the property list settles, on success or failure', async () => {
    seedSnapshot();
    let releaseList;
    api.getMe.mockResolvedValueOnce(FRESH_ME);
    api.getAuthProperties.mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve; }));
    await mount();
    expect(text('name')).toBe('Pat Fresh');
    expect(text('saved')).toBe('true');
    await act(async () => { releaseList(PROPS); });
    expect(text('saved')).toBe('false');
    cleanup();
    seedSnapshot();
    let rejectList;
    api.getMe.mockResolvedValueOnce(FRESH_ME);
    api.getAuthProperties.mockImplementationOnce(() => new Promise((_, reject) => { rejectList = reject; }));
    await mount();
    expect(text('saved')).toBe('true');
    await act(async () => { rejectList(new Error('offline')); });
    expect(text('saved')).toBe('false');
    expect(authApi.propertiesError).toBeTruthy();
  });

  it('a login published to storage by another tab (not yet adopted in memory) also discards the answer and adopts it', async () => {
    seedSnapshot();
    localStorage.setItem('waves_token', TOKEN);
    let releaseOld;
    api.getMe.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
    await mount();
    const other = makeToken({ customerId: 'cust-2', sessionId: 'fam-7' });
    localStorage.setItem('waves_token', other);
    api.getMe.mockImplementation(() => new Promise(() => {}));
    await act(async () => { releaseOld({ ...FRESH_ME, lastName: 'OldLogin' }); });
    expect(text('name')).toBe('');
    expect(text('saved')).toBe('false');
    expect(api.adoptTokens).toHaveBeenLastCalledWith(other, null);
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });

  it('a property list FAILURE for a replaced login is discarded too: nothing is published, the load restarts', async () => {
    localStorage.setItem('waves_token', TOKEN);
    let rejectList;
    api.getMe.mockResolvedValueOnce(FRESH_ME);
    api.getAuthProperties.mockImplementationOnce(() => new Promise((_, reject) => { rejectList = reject; }));
    await mount();
    const other = makeToken({ customerId: 'cust-1', sessionId: 'fam-8' });
    localStorage.setItem('waves_token', other);
    api.token = other;
    api.getMe.mockImplementation(() => new Promise(() => {}));
    await act(async () => { rejectList(new Error('offline')); });
    expect(text('name')).toBe('');
    expect(text('loading')).toBe('true');
    expect(authApi.propertiesError).toBeNull();
    expect(api.getMe).toHaveBeenCalledTimes(2);
  });
});
