/**
 * Store ops tools — unit tests with mocked ASC fetch + mocked googleapis.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), version/track mapping, that the Play
 * draft edit is ALWAYS deleted (never committed), and { error } on failure.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'mock-asc-jwt') }));

const mockEdits = {
  insert: jest.fn(),
  delete: jest.fn(),
  tracks: { list: jest.fn() },
};
jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({ getClient: jest.fn(async () => ({})) })),
    },
    androidpublisher: jest.fn(() => ({ edits: mockEdits })),
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
    expect(mockEdits.insert).not.toHaveBeenCalled();
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

  test('get_play_store_status reads tracks inside a draft edit and always deletes it', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    mockEdits.insert.mockResolvedValueOnce({ data: { id: 'edit-1' } });
    mockEdits.tracks.list.mockResolvedValueOnce({
      data: {
        tracks: [
          { track: 'production', releases: [{ name: '1.2 (12)', status: 'completed', versionCodes: ['12'] }] },
          { track: 'internal', releases: [{ name: '1.3 (13)', status: 'draft', versionCodes: ['13'] }] },
        ],
      },
    });
    mockEdits.delete.mockResolvedValueOnce({});

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toBeUndefined();
    expect(result.production_status).toBe('completed');
    expect(result.production_release).toBe('1.2 (12)');
    expect(result.total_tracks).toBe(2);
    expect(mockEdits.delete).toHaveBeenCalledWith(
      { packageName: 'com.wavespestcontrol.portal', editId: 'edit-1' },
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  test('the draft edit is deleted even when the track read fails', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    mockEdits.insert.mockResolvedValueOnce({ data: { id: 'edit-2' } });
    mockEdits.tracks.list.mockRejectedValueOnce(new Error('boom'));
    mockEdits.delete.mockResolvedValueOnce({});

    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toMatch(/boom/);
    expect(mockEdits.delete).toHaveBeenCalledWith(
      expect.objectContaining({ editId: 'edit-2' }),
      expect.anything(),
    );
  });

  test('invalid PLAY_SERVICE_ACCOUNT_JSON surfaces as { error }, never a throw', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = 'not-json';
    const result = await executeStoreOpsTool('get_play_store_status', {});
    expect(result.error).toMatch(/not valid JSON/);
    expect(mockEdits.insert).not.toHaveBeenCalled();
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

  test('every Play call carries the module timeout (gaxios has no default deadline)', async () => {
    process.env.PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sa@x.iam' });
    mockEdits.insert.mockResolvedValueOnce({ data: { id: 'edit-3' } });
    mockEdits.tracks.list.mockResolvedValueOnce({ data: { tracks: [] } });
    mockEdits.delete.mockResolvedValueOnce({});

    await executeStoreOpsTool('get_play_store_status', {});
    expect(mockEdits.insert.mock.calls[0][1]).toEqual({ timeout: 15000 });
    expect(mockEdits.tracks.list.mock.calls[0][1]).toEqual({ timeout: 15000 });
    expect(mockEdits.delete.mock.calls[0][1]).toEqual({ timeout: 15000 });
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
