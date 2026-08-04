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

describe('configuredPublicPortalOrigin()', () => {
   
  const { configuredPublicPortalOrigin } = require('../utils/portal-url');
  const ALL_VARS = [...VARS, 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT'];
  let envBefore;

  beforeEach(() => {
    envBefore = Object.fromEntries(ALL_VARS.map((v) => [v, process.env[v]]));
    for (const v of ALL_VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const k of ALL_VARS) {
      if (envBefore[k] === undefined) delete process.env[k];
      else process.env[k] = envBefore[k];
    }
  });

  test('returns the explicit origin when PUBLIC_PORTAL_URL is set', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://canonical.example.com/';
    expect(configuredPublicPortalOrigin()).toBe('https://canonical.example.com');
  });

  test('never trusts CLIENT_URL — on prod it is the raw Railway hostname', () => {
    process.env.CLIENT_URL = 'https://waves-portal-production.up.railway.app';
    expect(configuredPublicPortalOrigin()).toBe('');
  });

  test('CLIENT_URL-only PRODUCTION falls back to the canonical origin — permanent PDFs must never embed the Railway host (codex P2 #3176 r17)', () => {
    process.env.CLIENT_URL = 'https://waves-portal-production.up.railway.app';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    expect(configuredPublicPortalOrigin()).toBe('https://portal.wavespestcontrol.com');
  });

  test('legacy RAILWAY_ENVIRONMENT var also identifies production', () => {
    process.env.RAILWAY_ENVIRONMENT = 'Production';
    expect(configuredPublicPortalOrigin()).toBe('https://portal.wavespestcontrol.com');
  });

  test('a PREVIEW environment keeps the empty origin — its tokens resolve only on the preview host (r3)', () => {
    process.env.CLIENT_URL = 'https://waves-portal-pr-3176.up.railway.app';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'waves-customer-portal-pr-3176';
    expect(configuredPublicPortalOrigin()).toBe('');
  });

  test('local dev (no Railway vars) keeps the empty origin', () => {
    expect(configuredPublicPortalOrigin()).toBe('');
  });

  test('an explicit origin wins over the environment name', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://staging.example.com';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    expect(configuredPublicPortalOrigin()).toBe('https://staging.example.com');
  });
});

describe('publicOriginPdfSignature()', () => {
  const { publicOriginPdfSignature } = require('../utils/portal-url');
  const ALL_VARS = [...VARS, 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT', 'SERVICE_REPORT_PDF_BASE_URL'];
  let envBefore;

  beforeEach(() => {
    envBefore = Object.fromEntries(ALL_VARS.map((v) => [v, process.env[v]]));
    for (const v of ALL_VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const k of ALL_VARS) {
      if (envBefore[k] === undefined) delete process.env[k];
      else process.env[k] = envBefore[k];
    }
  });

  test('empty only when NOTHING is set — links are then truly renderer-relative', () => {
    expect(publicOriginPdfSignature()).toBe('');
  });

  test('with no configured origin, the renderer base is hashed — a moved preview base re-renders (codex P2 #3176 r20)', () => {
    process.env.CLIENT_URL = 'https://waves-portal-pr-3176.up.railway.app';
    const before = publicOriginPdfSignature();
    expect(before).toMatch(/^-o[0-9a-f]{8}$/);
    process.env.CLIENT_URL = 'https://waves-portal-pr-9999.up.railway.app';
    expect(publicOriginPdfSignature()).not.toBe(before);
  });

  test('SERVICE_REPORT_PDF_BASE_URL outranks CLIENT_URL, matching the renderer precedence', () => {
    process.env.CLIENT_URL = 'https://client.example.com';
    const clientOnly = publicOriginPdfSignature();
    process.env.SERVICE_REPORT_PDF_BASE_URL = 'https://pdfbase.example.com';
    expect(publicOriginPdfSignature()).not.toBe(clientOnly);
  });

  test('a configured origin yields a stable -o component', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
    const sig = publicOriginPdfSignature();
    expect(sig).toMatch(/^-o[0-9a-f]{8}$/);
    expect(publicOriginPdfSignature()).toBe(sig);
  });

  test('a domain migration changes the component — cached PDFs must re-render (codex P2 #3176 r18)', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
    const before = publicOriginPdfSignature();
    process.env.PUBLIC_PORTAL_URL = 'https://portal.waveslawnandpest-newdomain.com';
    expect(publicOriginPdfSignature()).not.toBe(before);
  });

  test('the production-name fallback counts as a configured origin', () => {
    process.env.CLIENT_URL = 'https://waves-portal-production.up.railway.app';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    expect(publicOriginPdfSignature()).toMatch(/^-o[0-9a-f]{8}$/);
  });
});
