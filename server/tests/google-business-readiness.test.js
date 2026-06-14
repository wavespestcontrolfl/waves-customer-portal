jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// googleapis (~71MB) is lazy-loaded and not exercised here — stub the only
// surface _getClient touches so a configured location yields a real client.
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        on() {}
      },
    },
  },
}), { virtual: true });

const db = require('../models/db');
const gbpService = require('../services/google-business');

// system_settings holds per-location OAuth tokens (refresh_token etc.).
function mockDb({ storedTokens = {} } = {}) {
  db.mockImplementation((table) => {
    if (table === 'system_settings') {
      return {
        where: ({ key }) => ({
          first: async () => (storedTokens[key] ? { key, value: JSON.stringify(storedTokens[key]) } : undefined),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

// isLocationConfigured caches OAuth2 clients per location; isolate each case.
function freshService() {
  gbpService._clients = {};
}

describe('google-business isLocationConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GBP_')) delete process.env[key];
    }
    freshService();
    mockDb();
  });

  afterAll(() => { process.env = originalEnv; });

  test('unknown location id → false (no env key mapping)', async () => {
    expect(await gbpService.isLocationConfigured('nonexistent-city')).toBe(false);
  });

  test('client ID/secret present but NO refresh token → false (the partial-setup footgun)', async () => {
    process.env.GBP_CLIENT_ID_SARASOTA = 'client-id';
    process.env.GBP_CLIENT_SECRET_SARASOTA = 'client-secret';
    // No GBP_REFRESH_TOKEN_SARASOTA and no stored token → cannot publish.
    expect(await gbpService.isLocationConfigured('sarasota')).toBe(false);
  });

  test('client creds + refresh token → true', async () => {
    process.env.GBP_CLIENT_ID_SARASOTA = 'client-id';
    process.env.GBP_CLIENT_SECRET_SARASOTA = 'client-secret';
    process.env.GBP_REFRESH_TOKEN_SARASOTA = 'refresh-token';
    expect(await gbpService.isLocationConfigured('sarasota')).toBe(true);
  });

  test('refresh token from stored tokens (admin connect flow) → true', async () => {
    process.env.GBP_CLIENT_ID_VENICE = 'client-id';
    process.env.GBP_CLIENT_SECRET_VENICE = 'client-secret';
    mockDb({ storedTokens: { 'gbp.oauth_tokens.venice': { refresh_token: 'stored-refresh' } } });
    expect(await gbpService.isLocationConfigured('venice')).toBe(true);
  });

  test('one location configured does not imply another is (per-location isolation)', async () => {
    process.env.GBP_CLIENT_ID_SARASOTA = 'client-id';
    process.env.GBP_CLIENT_SECRET_SARASOTA = 'client-secret';
    process.env.GBP_REFRESH_TOKEN_SARASOTA = 'refresh-token';
    expect(await gbpService.isLocationConfigured('sarasota')).toBe(true);
    // Parrish has nothing configured even though Sarasota does.
    expect(await gbpService.isLocationConfigured('parrish')).toBe(false);
  });
});
