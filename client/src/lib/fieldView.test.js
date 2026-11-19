// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminNavigationPreferenceKey, FIELD_VIEW_LANDING_STATE, fieldViewLanding, preloadFieldViewLanding, readFieldViewPreference, signInReturnLocation,
} from './fieldView';

// The two modules an open of Today needs, recorded when the preload loads them.
const loaded = vi.hoisted(() => []);
vi.mock('../pages/admin/TodayShell', () => { loaded.push('TodayShell'); return { default: () => null }; });
vi.mock('../pages/tech/TechHomePage', () => { loaded.push('TechHomePage'); return { default: () => null }; });
import { saveStaffOfflinePass } from './adminAuth';

const storageOf = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });
const on = JSON.stringify({ version: 2, fieldView: true });
const ADMIN = { id: 'acct-1', name: 'Fixture Admin', role: 'admin' };

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600, sig = 'fixture-signature') {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'HS256' })}.${part({ exp })}.${sig}`;
}
// A device a verified check left signed in: the token, its offline pass and
// the login's saved switch (null: none saved).
function signedIn({ token = staffJwt(), profile = ADMIN, passToken = token, fieldView = true } = {}) {
  localStorage.setItem('waves_admin_token', token);
  saveStaffOfflinePass(passToken, profile);
  if (fieldView !== null) localStorage.setItem(adminNavigationPreferenceKey(profile.id || 'none'), JSON.stringify({ version: 2, fieldView }));
}

afterEach(() => { localStorage.clear(); });

describe('fieldViewLanding (an open of /admin, before the session check)', () => {
  it('sends /admin and /admin/ to Today when this token\'s offline pass is an admin with Field view on', () => {
    signedIn();
    expect(fieldViewLanding('/admin')).toBe('/admin/today');
    expect(fieldViewLanding('/admin/')).toBe('/admin/today');
    expect(fieldViewLanding('/ADMIN')).toBe('/admin/today');
  });

  it('leaves every other path alone', () => {
    signedIn();
    for (const pathname of ['/admin/dashboard', '/admin/today', '/admin/customers', '/', '/administrator', '']) {
      expect(fieldViewLanding(pathname), pathname).toBeNull();
    }
  });

  it('does nothing with the switch off, missing, or saved for another login', () => {
    signedIn({ fieldView: false });
    expect(fieldViewLanding('/admin')).toBeNull();
    localStorage.clear();
    signedIn({ fieldView: null });
    expect(fieldViewLanding('/admin')).toBeNull();
    localStorage.setItem(adminNavigationPreferenceKey('acct-2'), on);
    expect(fieldViewLanding('/admin')).toBeNull();
  });

  // Pre-push P1: an expired session must not move to Today, or the sign-in
  // it ends in returns the next login there.
  it('does nothing when the token has expired, so the shell checks the login at /admin', () => {
    signedIn({ token: staffJwt(Math.floor(Date.now() / 1000) - 60) });
    expect(fieldViewLanding('/admin')).toBeNull();
  });

  it('does nothing with no token, no pass, or a pass left for another token', () => {
    signedIn();
    localStorage.removeItem('waves_admin_token');
    expect(fieldViewLanding('/admin')).toBeNull();
    localStorage.clear();
    localStorage.setItem('waves_admin_token', staffJwt());
    localStorage.setItem(adminNavigationPreferenceKey('acct-1'), on);
    expect(fieldViewLanding('/admin')).toBeNull();
    localStorage.clear();
    signedIn({ passToken: staffJwt(undefined, 'older-signature') });
    expect(fieldViewLanding('/admin')).toBeNull();
  });

  it('does nothing for a pass whose login is not an admin', () => {
    signedIn({ profile: { id: 'tech-1', name: 'Fixture Tech', role: 'technician' } });
    expect(fieldViewLanding('/admin')).toBeNull();
  });

  it('does nothing for a bad saved value or storage that throws', () => {
    signedIn();
    localStorage.setItem(adminNavigationPreferenceKey('acct-1'), '{nope');
    expect(fieldViewLanding('/admin')).toBeNull();
    localStorage.setItem(adminNavigationPreferenceKey('acct-1'), JSON.stringify({ fieldView: 'true' }));
    expect(fieldViewLanding('/admin')).toBeNull();
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    try { expect(fieldViewLanding('/admin')).toBeNull(); } finally { Storage.prototype.getItem = getItem; }
  });
});

describe('signInReturnLocation', () => {
  it('returns a Field view landing on Today to /admin, and any other address to itself', () => {
    expect(signInReturnLocation({ pathname: '/admin/today', search: '', hash: '', state: FIELD_VIEW_LANDING_STATE }))
      .toEqual({ pathname: '/admin', search: '', hash: '' });
    const byHand = { pathname: '/admin/today', search: '?visit=1', hash: '', state: null };
    expect(signInReturnLocation(byHand)).toBe(byHand);
    const other = { pathname: '/admin/customers', search: '', hash: '', state: { from: 'x' } };
    expect(signInReturnLocation(other)).toBe(other);
  });
});

// Pre-push P1 (round 5): turning Field view on readies Today for a later
// open with no signal.
describe('preloadFieldViewLanding', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("loads Today's shell and page", async () => {
    await expect(preloadFieldViewLanding()).resolves.toBe(true);
    expect([...loaded].sort()).toEqual(['TechHomePage', 'TodayShell']);
  });
  it('reports false at once with no signal', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await expect(preloadFieldViewLanding()).resolves.toBe(false);
  });
});

describe('readFieldViewPreference', () => {
  it('reads true only for a saved boolean true, per account', () => {
    const storage = storageOf({ [adminNavigationPreferenceKey('acct-1')]: on });
    expect(readFieldViewPreference('acct-1', storage)).toBe(true);
    expect(readFieldViewPreference('acct-2', storage)).toBe(false);
    expect(readFieldViewPreference('', storage)).toBe(false);
  });
});
