/**
 * /.well-known — universal-link association files (routes/well-known.js).
 *
 * Contract (mirrored in AGENTS.md's public-route inventory):
 *  - Both files 404 while GATE_UNIVERSAL_LINKS is off (dark by default).
 *  - AASA additionally 404s without a team ID; assetlinks.json additionally
 *    404s without ANDROID_ASSETLINKS_SHA256 — so the gate can flip before the
 *    Android fingerprints are known without serving a half-empty file.
 *  - AASA excludes /admin/*, /tech/*, /api/* (customer-only shell; PDFs and
 *    webhooks must never be claimed by the app).
 *  - assetlinks fingerprints are normalized to uppercase (Play Console copies
 *    are uppercase; verifiers compare case-sensitively).
 *  - Content-Type must be application/json for both (Apple's CDN and
 *    Android's Digital Asset Links verifier both require it).
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const express = require('express');
const { isEnabled } = require('../config/feature-gates');

let server;
let base;

const ENV_KEYS = ['APPLE_TEAM_ID', 'APNS_TEAM_ID', 'ANDROID_ASSETLINKS_SHA256', 'APNS_BUNDLE_ID'];
const savedEnv = {};

beforeAll(async () => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  const app = express();
  app.use('/.well-known', require('../routes/well-known'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APNS_TEAM_ID;
  delete process.env.ANDROID_ASSETLINKS_SHA256;
});

const aasa = () => fetch(`${base}/.well-known/apple-app-site-association`);
const assetlinks = () => fetch(`${base}/.well-known/assetlinks.json`);

describe('gate off (default)', () => {
  test('both files 404 even with identity env present', async () => {
    process.env.APNS_TEAM_ID = 'TEAM123456';
    process.env.ANDROID_ASSETLINKS_SHA256 = 'AA:BB';
    expect((await aasa()).status).toBe(404);
    expect((await assetlinks()).status).toBe(404);
  });
});

describe('apple-app-site-association', () => {
  beforeEach(() => isEnabled.mockReturnValue(true));

  test('404s with the gate on but no team ID configured', async () => {
    expect((await aasa()).status).toBe(404);
  });

  test('serves applinks JSON with staff/api exclusions ahead of the catch-all', async () => {
    process.env.APNS_TEAM_ID = 'TEAM123456';
    const res = await aasa();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    const detail = body.applinks.details[0];
    expect(detail.appIDs).toEqual(['TEAM123456.com.wavespestcontrol.portal']);
    const components = detail.components;
    const catchAllIdx = components.findIndex((c) => c['/'] === '*');
    // Exact roots AND descendants — a bare '/admin' link must not fall
    // through to the catch-all. '/r' referral links 302 to the marketing
    // site, so they stay in the browser.
    for (const excluded of ['/admin', '/admin/*', '/tech', '/tech/*', '/api', '/api/*', '/r', '/r/*']) {
      const idx = components.findIndex((c) => c['/'] === excluded);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(components[idx].exclude).toBe(true);
      expect(idx).toBeLessThan(catchAllIdx); // components match in order
    }
    expect(body.webcredentials.apps).toEqual(['TEAM123456.com.wavespestcontrol.portal']);
  });

  test('APPLE_TEAM_ID overrides APNS_TEAM_ID', async () => {
    process.env.APNS_TEAM_ID = 'PUSHTEAM01';
    process.env.APPLE_TEAM_ID = 'REALTEAM01';
    const body = await (await aasa()).json();
    expect(body.applinks.details[0].appIDs).toEqual(['REALTEAM01.com.wavespestcontrol.portal']);
  });
});

describe('assetlinks.json', () => {
  beforeEach(() => isEnabled.mockReturnValue(true));

  test('404s with the gate on but no fingerprints configured', async () => {
    expect((await assetlinks()).status).toBe(404);
  });

  test('serves the handle_all_urls statement with normalized fingerprints', async () => {
    process.env.ANDROID_ASSETLINKS_SHA256 = ' aa:bb:cc , DD:EE:FF ,';
    const res = await assetlinks();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.wavespestcontrol.portal',
          sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'],
        },
      },
    ]);
  });
});
