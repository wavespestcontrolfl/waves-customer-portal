/**
 * portal-url helper — fallback chain + URL normalization.
 *
 * Pins the contract described in server/utils/portal-url.js so future
 * env-var pruning (removing PORTAL_DOMAIN / PORTAL_URL / CLIENT_URL once
 * Railway is migrated to PUBLIC_PORTAL_URL only) can't silently break
 * customer-facing link generation.
 */

const { publicPortalUrl, portalUrl } = require('../utils/portal-url');

const VARS = ['PUBLIC_PORTAL_URL', 'PORTAL_URL', 'CLIENT_URL', 'PORTAL_DOMAIN'];

function snapshotEnv() {
  return Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
}

function restoreEnv(snap) {
  for (const k of VARS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearEnv() {
  for (const v of VARS) delete process.env[v];
}

describe('publicPortalUrl()', () => {
  let envBefore;

  beforeEach(() => {
    envBefore = snapshotEnv();
    clearEnv();
  });

  afterEach(() => {
    restoreEnv(envBefore);
  });

  test('prefers PUBLIC_PORTAL_URL', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://canonical.example.com';
    process.env.PORTAL_URL = 'https://wrong-portal.example.com';
    process.env.CLIENT_URL = 'https://wrong-client.example.com';
    expect(publicPortalUrl()).toBe('https://canonical.example.com');
  });

  test('falls back to PORTAL_URL when PUBLIC_PORTAL_URL is unset', () => {
    process.env.PORTAL_URL = 'https://portal.example.com';
    expect(publicPortalUrl()).toBe('https://portal.example.com');
  });

  test('falls back to CLIENT_URL when above two are unset', () => {
    process.env.CLIENT_URL = 'https://client.example.com';
    expect(publicPortalUrl()).toBe('https://client.example.com');
  });

  test('falls back to PORTAL_DOMAIN as a final back-compat', () => {
    process.env.PORTAL_DOMAIN = 'https://domain.example.com';
    expect(publicPortalUrl()).toBe('https://domain.example.com');
  });

  test('uses production default when no env var is set', () => {
    expect(publicPortalUrl()).toBe('https://portal.wavespestcontrol.com');
  });

  test('prepends https:// when PORTAL_DOMAIN is a bare hostname (the historical footgun)', () => {
    process.env.PORTAL_DOMAIN = 'portal.wavespestcontrol.com';
    expect(publicPortalUrl()).toBe('https://portal.wavespestcontrol.com');
  });

  test('preserves http:// when explicitly set (local dev http://localhost:5173)', () => {
    process.env.CLIENT_URL = 'http://localhost:5173';
    expect(publicPortalUrl()).toBe('http://localhost:5173');
  });

  test('strips trailing slash', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com/';
    expect(publicPortalUrl()).toBe('https://portal.wavespestcontrol.com');
  });

  test('strips multiple trailing slashes', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com///';
    expect(publicPortalUrl()).toBe('https://portal.wavespestcontrol.com');
  });

  test('treats empty-string env var as unset and uses fallback', () => {
    process.env.PUBLIC_PORTAL_URL = '';
    process.env.PORTAL_URL = 'https://from-portal-url.example.com';
    expect(publicPortalUrl()).toBe('https://from-portal-url.example.com');
  });
});

describe('portalUrl(path)', () => {
  let envBefore;

  beforeEach(() => {
    envBefore = snapshotEnv();
    clearEnv();
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
  });

  afterEach(() => {
    restoreEnv(envBefore);
  });

  test('joins origin + path with exactly one slash when path has leading slash', () => {
    expect(portalUrl('/pay/tok-xyz')).toBe('https://portal.wavespestcontrol.com/pay/tok-xyz');
  });

  test('inserts a slash when path has no leading slash', () => {
    expect(portalUrl('pay/tok-xyz')).toBe('https://portal.wavespestcontrol.com/pay/tok-xyz');
  });

  test('omits the path entirely when empty', () => {
    expect(portalUrl('')).toBe('https://portal.wavespestcontrol.com');
    expect(portalUrl()).toBe('https://portal.wavespestcontrol.com');
  });

  test('handles env value with trailing slash without producing a double slash', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com/';
    expect(portalUrl('/pay/tok')).toBe('https://portal.wavespestcontrol.com/pay/tok');
  });
});
