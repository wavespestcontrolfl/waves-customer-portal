// @vitest-environment jsdom
// Saved-property scope (GATE_APP_PROPERTY_SCOPE) in the auth hook: the
// unified list is adopted through the client property shape, the session's
// selection is exposed, and switchProperty sends the (profile, property) pair
// while legacy string callers keep working.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth, applyPropertyPayload, savedPropertyDisplayLabel, tokenPropertyId } from './useAuth';

vi.mock('../native/nativeBadge', () => ({ clearNativeBadge: vi.fn() }));
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
    getAuthProperties: vi.fn(async () => ({ properties: [] })),
    selectAuthProperty: vi.fn(),
    setTokens: vi.fn(function setTokens(t, r) { this.token = t; this.refreshToken = r; }),
    adoptTokens: vi.fn(function adoptTokens(t, r) { this.token = t; this.refreshToken = r; }),
    clearTokens: vi.fn(function clearTokens() { this.token = null; this.refreshToken = null; }),
    request: vi.fn(async () => ({ success: true })),
  },
}));

import api from '../utils/api';
import { repostNativePushToken } from '../native/nativePush';

const SAVED = {
  scope: 'saved',
  selected: { key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a' },
  properties: [
    { key: 'cust-1:prop-a', customerId: 'cust-1', propertyId: 'prop-a', isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: true, label: 'Primary', relationship: 'own_home', address: { line1: '1200 Palm Row Ct', city: 'Parrish', state: 'FL', zip: '34219' } },
    { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b', isPrimaryProfile: true, profileLabel: 'Primary', isPrimaryProperty: false, label: null, relationship: 'family_home', address: { line1: '418 Oak Ave', city: 'Bradenton', state: 'FL', zip: '34205' } },
    { key: 'cust-9:prop-z', customerId: 'cust-9', propertyId: 'prop-z', isPrimaryProfile: false, profileLabel: 'Rental - Sandbar Ln', isPrimaryProperty: true, label: 'Primary', relationship: 'rental_owned', address: { line1: '9 Sandbar Ln', city: 'Ellenton', state: 'FL', zip: '34222' } },
  ],
};

let authApi;
function Probe() {
  authApi = useAuth();
  return (
    <>
      <div data-testid="customer-id">{authApi.customer?.id || ''}</div>
      <div data-testid="scope">{authApi.propertyScope}</div>
      <div data-testid="selected">{authApi.selectedProperty?.key || ''}</div>
      <div data-testid="labels">{authApi.properties.map((p) => `${p.id}=${p.profileLabel}`).join('|')}</div>
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

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.token = null; api.refreshToken = null;
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('applyPropertyPayload / savedPropertyDisplayLabel (pure)', () => {
  it('maps saved entries onto the client shape keyed by entry key; profile payloads pass through', () => {
    const saved = applyPropertyPayload(SAVED);
    expect(saved.scope).toBe('saved');
    expect(saved.properties.map((p) => p.id)).toEqual(['cust-1:prop-a', 'cust-1:prop-b', 'cust-9:prop-z']);
    // Primary profile's primary property = the home tile; its siblings are not.
    expect(saved.properties.map((p) => p.isPrimaryProfile)).toEqual([true, false, false]);
    expect(saved.selected).toEqual(SAVED.selected);
    const profile = applyPropertyPayload({ properties: [{ id: 'cust-1', profileLabel: 'Home' }] });
    expect(profile).toEqual({ scope: 'profile', properties: [{ id: 'cust-1', profileLabel: 'Home' }], selected: null });
  });

  it('labels: an office label wins, the primary reads "Home" (or its profile label), a secondary reads its street', () => {
    expect(savedPropertyDisplayLabel(SAVED.properties[0])).toBe('Home');
    expect(savedPropertyDisplayLabel(SAVED.properties[1])).toBe('418 Oak Ave');
    expect(savedPropertyDisplayLabel(SAVED.properties[2])).toBe('Rental - Sandbar Ln');
    expect(savedPropertyDisplayLabel({ ...SAVED.properties[1], label: 'Lake house' })).toBe('Lake house');
  });
});

describe('AuthProvider under the saved-property scope', () => {
  it('asks for the saved list, exposes scope + selection, and switches by the (profile, property) pair without re-posting the push token', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue(SAVED);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });

    expect(api.getAuthProperties).toHaveBeenCalledWith({ scope: 'saved' });
    expect(screen.getByTestId('scope').textContent).toBe('saved');
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-a');
    expect(screen.getByTestId('labels').textContent).toBe('cust-1:prop-a=Home|cust-1:prop-b=418 Oak Ave|cust-9:prop-z=Rental - Sandbar Ln');

    // Same-profile switch to the family home.
    api.selectAuthProperty.mockResolvedValue({ token: 'tok-b', refreshToken: 'ref-b', properties: [{ id: 'cust-1' }], selected: { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' } });
    api.getAuthProperties.mockResolvedValue({ ...SAVED, selected: { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' } });
    let ok;
    await act(async () => { ok = await authApi.switchProperty({ customerId: 'cust-1', propertyId: 'prop-b' }); });
    expect(ok).toBe(true);
    expect(api.selectAuthProperty).toHaveBeenCalledWith('cust-1', 'prop-b');
    expect(api.setTokens).toHaveBeenCalledWith('tok-b', 'ref-b');
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');
    // The switch response's PROFILE list must not collapse the unified list.
    expect(screen.getByTestId('labels').textContent).toBe('cust-1:prop-a=Home|cust-1:prop-b=418 Oak Ave|cust-9:prop-z=Rental - Sandbar Ln');
    // Same customer row → the device's push subscription stays put.
    expect(repostNativePushToken).not.toHaveBeenCalled();

    // Cross-profile switch (the rental) re-points the push subscription.
    api.getMe.mockResolvedValue({ id: 'cust-9' });
    api.selectAuthProperty.mockResolvedValue({ token: 'tok-z', refreshToken: 'ref-z', properties: [], selected: { key: 'cust-9:prop-z', customerId: 'cust-9', propertyId: 'prop-z' } });
    await act(async () => { await authApi.switchProperty({ customerId: 'cust-9', propertyId: 'prop-z' }); });
    expect(api.selectAuthProperty).toHaveBeenLastCalledWith('cust-9', 'prop-z');
    expect(repostNativePushToken).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-9');
  });

  it('a legacy string target still switches by profile id with no property', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue({ properties: [{ id: 'cust-1' }, { id: 'cust-b' }] });
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    expect(screen.getByTestId('scope').textContent).toBe('profile');
    api.selectAuthProperty.mockResolvedValue({ token: 'tok-b', refreshToken: 'ref-b', properties: [{ id: 'cust-b' }] });
    api.getMe.mockResolvedValue({ id: 'cust-b' });
    await act(async () => { await authApi.switchProperty('cust-b'); });
    expect(api.selectAuthProperty).toHaveBeenCalledWith('cust-b', null);
    expect(screen.getByTestId('selected').textContent).toBe('');
    expect(repostNativePushToken).toHaveBeenCalledTimes(1);
  });
});

describe('cross-tab saved-property switch', () => {
  const b64u = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tokenFor = (payload) => `${b64u({ alg: 'none' })}.${b64u(payload)}.x`;

  it('tokenPropertyId reads the claim and is null without one', () => {
    expect(tokenPropertyId(tokenFor({ customerId: 'c1', sessionId: 'f', propertyId: 'pb' }))).toBe('pb');
    expect(tokenPropertyId(tokenFor({ customerId: 'c1', sessionId: 'f' }))).toBeNull();
    expect(tokenPropertyId('garbage')).toBeNull();
  });

  it('a same-family token whose propertyId changed in another tab bumps the epoch, so a stale property list from before the switch is discarded', async () => {
    const tokA = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'prop-a' });
    const tokB = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'prop-b' });
    const store = { waves_token: tokA, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue(SAVED);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-a');
    const epochBefore = authApi.sessionEpoch;

    // A property-list read is in flight under the OLD selection...
    let resolveStale;
    api.getAuthProperties.mockReturnValueOnce(new Promise((res) => { resolveStale = res; }));
    let stalePromise;
    await act(async () => { stalePromise = authApi.refreshProperties(); });

    // ...another tab switches the SAME profile to prop-b (same family).
    const selectedB = { key: 'cust-1:prop-b', customerId: 'cust-1', propertyId: 'prop-b' };
    api.getAuthProperties.mockResolvedValue({ ...SAVED, selected: selectedB });
    await act(async () => {
      store.waves_token = tokB;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: tokB }));
    });
    expect(authApi.sessionEpoch).toBe(epochBefore + 1);
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');

    // The stale response lands afterwards and must NOT repaint prop-a.
    await act(async () => { resolveStale(SAVED); await stalePromise; });
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');
  });

  it('a cross-tab property change resolves the selection from the token immediately, even when the follow-up list read fails', async () => {
    const tokA = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'prop-a' });
    const tokB = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'prop-b' });
    const store = { waves_token: tokA, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue(SAVED);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-a');
    // The re-read after the cross-tab switch fails (offline) — the selection must already say prop-b.
    api.getAuthProperties.mockRejectedValue(new Error('offline'));
    await act(async () => {
      store.waves_token = tokB;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: tokB }));
    });
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-1');
    api.getAuthProperties.mockResolvedValue(SAVED);
  });

  it('a fresh tab whose saved-property list read fails still derives its selection from the token claim', async () => {
    const tokB = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', propertyId: 'prop-b' });
    stubLocalStorage({ waves_token: tokB, waves_refresh_token: 'ref-b' });
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockRejectedValue(new Error('offline'));
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    expect(screen.getByTestId('customer-id').textContent).toBe('cust-1');
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');
    api.getAuthProperties.mockResolvedValue(SAVED);
  });

  it('a routine same-family rotation without a property change keeps the epoch', async () => {
    const tokA1 = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', nonce: 1 });
    const tokA2 = tokenFor({ customerId: 'cust-1', sessionId: 'fam-1', nonce: 2 });
    const store = { waves_token: tokA1, waves_refresh_token: 'ref-a' };
    stubLocalStorage(store);
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue({ properties: [{ id: 'cust-1' }] });
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    const epochBefore = authApi.sessionEpoch;
    await act(async () => {
      store.waves_token = tokA2;
      window.dispatchEvent(new StorageEvent('storage', { key: 'waves_token', newValue: tokA2 }));
    });
    expect(authApi.sessionEpoch).toBe(epochBefore);
  });

  it('a switch response that names the selection by ids alone still yields the entry key the page compares against', async () => {
    stubLocalStorage({ waves_token: 'tok-a', waves_refresh_token: 'ref-a' });
    api.getMe.mockResolvedValue({ id: 'cust-1' });
    api.getAuthProperties.mockResolvedValue(SAVED);
    await act(async () => { render(<AuthProvider><Probe /></AuthProvider>); });
    // Follow-up list read fails: the selection must still carry a key.
    api.selectAuthProperty.mockResolvedValue({ token: 'tok-b', refreshToken: 'ref-b', properties: [], selected: { customerId: 'cust-1', propertyId: 'prop-b' } });
    api.getAuthProperties.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await authApi.switchProperty({ customerId: 'cust-1', propertyId: 'prop-b' }); });
    expect(screen.getByTestId('selected').textContent).toBe('cust-1:prop-b');
  });
});
