// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminNavigationPreferenceKey, FIELD_VIEW_LANDING_STATE, fieldViewLanding, readFieldViewPreference, signInReturnLocation,
} from './fieldView';
import { saveStaffOfflinePass } from './adminAuth';
import { FIELD_VIEW_ASSETS_ID } from './fieldViewAssets';

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

// Pre-push P1 (rounds 5 to 7): Field view readies Today's code for an open
// with no signal, and says when it could not. A fresh module per test,
// because a session warms once per page.
describe('warmFieldViewLanding', () => {
  const TODAY_FILES = ['/assets/TodayShell-b2.js', '/assets/TechFieldShell-c3.css', '/assets/TechHomePage-d4.js'];

  // The page's own build list, as the build writes it into index.html.
  function listTodayFiles(files = TODAY_FILES) {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = FIELD_VIEW_ASSETS_ID;
    element.textContent = JSON.stringify(files);
    document.head.appendChild(element);
  }

  // A service worker in control of the page. It stores a file a moment after
  // it answered the request for it, unless `stores` says it cannot.
  function controlledBy({ stored = [], stores = () => true } = {}) {
    const cache = new Set(stored);
    vi.stubGlobal('caches', { match: vi.fn(async (url) => (cache.has(url) ? {} : undefined)) });
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (stores(url)) setTimeout(() => cache.add(url), 100);
      return { arrayBuffer: async () => new ArrayBuffer(0) };
    }));
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {} } });
  }

  async function freshWarm() {
    vi.resetModules();
    return (await import('./fieldView')).warmFieldViewLanding;
  }

  afterEach(() => {
    document.getElementById(FIELD_VIEW_ASSETS_ID)?.remove();
    delete navigator.serviceWorker;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Pre-push P1 (round 8): the worker claims a stored file for this build only
  // when it answers a request for it, so the warm asks for every file.
  it('asks the worker for every file, stored or not, and reports true once it stored each', async () => {
    vi.useFakeTimers();
    listTodayFiles();
    controlledBy({ stored: ['/assets/TodayShell-b2.js'] });
    const warm = await freshWarm();
    const ready = warm();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(ready).resolves.toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(TODAY_FILES);
  });

  it('reports false when the worker could not store a file (full storage)', async () => {
    vi.useFakeTimers();
    listTodayFiles();
    controlledBy({ stores: (url) => url !== '/assets/TechHomePage-d4.js' });
    const warm = await freshWarm();
    const ready = warm();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(ready).resolves.toBe(false);
  });

  it('reports true at once when the phone holds every file, after asking the worker for each', async () => {
    listTodayFiles();
    controlledBy({ stored: TODAY_FILES });
    const warm = await freshWarm();
    await expect(warm()).resolves.toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(TODAY_FILES);
  });

  // Pre-push P1 (round 8): a try before the worker took control must not
  // block the next one for the rest of the page.
  it('keeps only a success: the next call after a failed try runs again', async () => {
    listTodayFiles();
    controlledBy({ stored: TODAY_FILES });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: null } });
    const warm = await freshWarm();
    await expect(warm()).resolves.toBe(false);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {} } });
    await expect(warm()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(TODAY_FILES.length);
    await expect(warm()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(TODAY_FILES.length);
  });

  it('with no signal reports false and asks for nothing; the next try with signal runs', async () => {
    listTodayFiles();
    controlledBy({ stored: TODAY_FILES });
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const warm = await freshWarm();
    await expect(warm()).resolves.toBe(false);
    expect(caches.match).not.toHaveBeenCalled();
    onLine.mockReturnValue(true);
    await expect(warm()).resolves.toBe(true);
    expect(caches.match).toHaveBeenCalledTimes(TODAY_FILES.length);
  });

  it('with no service worker in control reports false and asks for nothing', async () => {
    listTodayFiles();
    controlledBy();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: null } });
    const warm = await freshWarm();
    await expect(warm()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('with no list says nothing on the dev server, and false in a production build', async () => {
    controlledBy();
    await expect((await freshWarm())()).resolves.toBeNull();
    vi.stubEnv('DEV', '');
    await expect((await freshWarm())()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tries once per page; the switch's own tap tries again", async () => {
    listTodayFiles();
    controlledBy({ stored: TODAY_FILES });
    const warm = await freshWarm();
    const first = warm();
    expect(warm()).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(caches.match).toHaveBeenCalledTimes(TODAY_FILES.length);
    await expect(warm({ again: true })).resolves.toBe(true);
    expect(caches.match).toHaveBeenCalledTimes(TODAY_FILES.length * 2);
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
