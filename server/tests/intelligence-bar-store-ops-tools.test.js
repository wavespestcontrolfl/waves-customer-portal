/**
 * Store ops tools — unit tests with mocked ASC + Play fetch and a mocked
 * GoogleAuth token source. Verifies the read-only contract: benign shape when
 * unconfigured (must not trip the shared admin breaker), version/release
 * mapping, live-vs-pending split, that Play is read via the NON-edit
 * releases endpoint (no edit created), and { error } on failure.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'mock-asc-jwt') }));

// Play now reads via raw REST with a GoogleAuth access token — no edit client.
jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({
        getClient: jest.fn(async () => ({
          getAccessToken: jest.fn(async () => ({ token: 'play-token' })),
        })),
      })),
    },
  },
}));

const STORE_ENV_KEYS = [
  'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_APP_ID', 'ASC_API_BASE',
  'PLAY_SERVICE_ACCOUNT_JSON', 'PLAY_PACKAGE_NAME',
];

const savedEnv = {};
let executeStoreOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of STORE_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of STORE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  for (const key of STORE_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeStoreOpsTool } = require('../services/intelligence-bar/store-ops-tools'));
});

describe('intelligence bar store ops tools', () => {
  test('unconfigured ASC state is benign — no error field and no network call', async () => {
    const result = await executeStoreOpsTool('get_app_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/ASC_KEY_ID/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unconfigured Play state is benign', async () => {
    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/PLAY_SERVICE_ACCOUNT_JSON/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    const result = await executeStoreOpsTool('submit_app', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_app_store_status maps versions and surfaces the live + in-flight set', async () => {
    process.env.ASC_KEY_ID = 'KEY1';
    process.env.ASC_ISSUER_ID = 'ISSUER1';
    process.env.ASC_PRIVATE_KEY = 'pem';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { attributes: { versionString: '1.3', appStoreState: 'IN_REVIEW', platform: 'IOS', createdDate: '2026-07-12' } },
        { attributes: { versionString: '1.2', appStoreState: 'READY_FOR_SALE', platform: 'IOS', createdDate: '2026-07-09' } },
        { attributes: { versionString: '1.1', appStoreState: 'REPLACED_WITH_NEW_VERSION', platform: 'IOS', createdDate: '2026-07-08' } },
      ],
    }));

    const result = await executeStoreOpsTool('get_app_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.live_version).toBe('1.2');
    expect(result.in_flight).toEqual([
      { version: '1.3', state: 'IN_REVIEW', platform: 'IOS', created: '2026-07-12' },
    ]);
    expect(result.total).toBe(3);
  });

  test('appVersionState READY_FOR_DISTRIBUTION counts as live, not in-flight', async () => {
    process.env.ASC_KEY_ID = 'KEY1';
    process.env.ASC_ISSUER_ID = 'ISSUER1';
    process.env.ASC_PRIVATE_KEY = 'pem';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { attributes: { versionString: '1.4', appVersionState: 'IN_REVIEW', platform: 'IOS', createdDate: '2026-07-12' } },
        { attributes: { versionString: '1.3', appVersionState: 'READY_FOR_DISTRIBUTION', platform: 'IOS', createdDate: '2026-07-10' } },
      ],
    }));

    const result = await executeStoreOpsTool('get_app_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.live_version).toBe('1.3');
    expect(result.in_flight).toEqual([
      { version: '1.4', state: 'IN_REVIEW', platform: 'IOS', created: '2026-07-12' },
    ]);
  });

  test('when multiple versions are live, the newest by created date is chosen', async () => {
    process.env.ASC_KEY_ID = 'KEY1';
    process.env.ASC_ISSUER_ID = 'ISSUER1';
    process.env.ASC_PRIVATE_KEY = 'pem';
    // Response order intentionally puts the OLDER live row first.
    global.fetch.mockResolvedValueOnce(jsonResponse({
      data: [
        { attributes: { versionString: '1.1', appStoreState: 'READY_FOR_SALE', platform: 'IOS', createdDate: '2026-07-01' } },
        { attributes: { versionString: '1.2', appStoreState: 'READY_FOR_SALE', platform: 'IOS', createdDate: '2026-07-09' } },
      ],
    }));

    const result = await executeStoreOpsTool('get_app_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.live_version).toBe('1.2');
  });

  test('get_play_store_status reads release summaries from the non-edit endpoint and splits live vs pending', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ releases: [
        { releaseName: '1.2 (12)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: 12 }] },
        { releaseName: '1.3 (13)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW', activeArtifacts: [{ versionCode: 13 }] },
      ] }))
      .mockResolvedValue(jsonResponse({}, 404)); // beta / alpha / internal not configured

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.production_status).toBe('RELEASE_LIFECYCLE_STATE_PUBLISHED');
    expect(result.production_release).toBe('1.2 (12)');
    expect(result.pending_release).toEqual({
      name: '1.3 (13)', lifecycle_state: 'RELEASE_LIFECYCLE_STATE_IN_REVIEW', version_codes: [13],
    });
    expect(result.total_tracks).toBe(1);
    // first call hits the production releases endpoint with a Bearer token; no edit is created
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/applications/com.wavespestcontrol.portal/tracks/production/releases');
    expect(opts.headers.Authorization).toBe('Bearer play-token');
  });

  test('a rejected pending build is surfaced separately from the live release', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ releases: [
        { releaseName: '1.2 (12)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: 12 }] },
        { releaseName: '1.3 (13)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_NOT_APPROVED', activeArtifacts: [{ versionCode: 13 }] },
      ] }))
      .mockResolvedValue(jsonResponse({}, 404));

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.production_status).toBe('RELEASE_LIFECYCLE_STATE_PUBLISHED');
    expect(result.pending_release.lifecycle_state).toBe('RELEASE_LIFECYCLE_STATE_NOT_APPROVED');
    expect(result.production_releases).toHaveLength(2);
  });

  test('a track that 404s is skipped; other tracks still read', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({}, 404)) // production not configured
      .mockResolvedValueOnce(jsonResponse({ releases: [
        { releaseName: '1.0-beta', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: 5 }] },
      ] })) // beta
      .mockResolvedValue(jsonResponse({}, 404)); // alpha / internal

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.production_status).toBeNull();
    expect(result.production_release).toBeNull();
    expect(result.total_tracks).toBe(1);
    expect(result.tracks[0].track).toBe('beta');
  });

  test('with multiple PUBLISHED production releases, the highest version code is the live one', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ releases: [
        { releaseName: '1.2 (12)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: 12 }] },
        { releaseName: '1.3 (13)', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: 13 }] },
      ] }))
      .mockResolvedValue(jsonResponse({}, 404));

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.production_release).toBe('1.3 (13)');
    expect(result.production_status).toBe('RELEASE_LIFECYCLE_STATE_PUBLISHED');
  });

  test('all tracks 404 (wrong package / no access) surfaces as { error }, not empty success', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch.mockResolvedValue(jsonResponse({}, 404)); // every track missing
    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toMatch(/PLAY_PACKAGE_NAME|access|No Play tracks/i);
    expect(result.total_tracks).toBeUndefined();
  });

  test('a Play permission error surfaces as { error }, never a throw', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch.mockResolvedValue(jsonResponse({}, 403));
    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toMatch(/app access|rejected/i);
  });

  test('invalid PLAY_SERVICE_ACCOUNT_JSON surfaces as { error }, never a throw', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = 'not-json';
    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toMatch(/not valid JSON/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('escaped \\n in ASC_PRIVATE_KEY is normalized before signing (Railway stores .p8 that way)', async () => {
    process.env.ASC_KEY_ID = 'KEY1';
    process.env.ASC_ISSUER_ID = 'ISSUER1';
    process.env.ASC_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----';
    global.fetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await executeStoreOpsTool('get_app_store_status', {});
    const jwt = require('jsonwebtoken');
    const signedKey = jwt.sign.mock.calls[0][1];
    expect(signedKey).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  });

  test('no Play edit is ever created — status is a pure read (no invalidation risk)', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    global.fetch.mockResolvedValue(jsonResponse({ releases: [] })); // every track empty

    await executeStoreOpsTool('get_play_store_status', {});
    // All calls are GETs to .../releases; none create or mutate an edit.
    for (const [url, opts] of global.fetch.mock.calls) {
      expect(url).toMatch(/\/tracks\/[^/]+\/releases$/);
      expect(opts.method === undefined || opts.method === 'GET').toBe(true);
    }
  });

  test('ASC auth rejection surfaces a key hint as { error }', async () => {
    process.env.ASC_KEY_ID = 'KEY1';
    process.env.ASC_ISSUER_ID = 'ISSUER1';
    process.env.ASC_PRIVATE_KEY = 'pem';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await executeStoreOpsTool('get_app_store_status', {});
    expect(result.error).toMatch(/ASC_KEY_ID/);
  });
});
