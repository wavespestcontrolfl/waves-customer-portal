jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const tokenHealth = require('../services/token-health');

// db('system_settings') serves stored OAuth tokens; db('token_credentials')
// absorbs upsertResult writes.
function mockDb({ storedTokens = {} } = {}) {
  db.mockImplementation((table) => {
    if (table === 'system_settings') {
      return {
        where: ({ key }) => ({
          first: async () => (storedTokens[key] ? { key, value: JSON.stringify(storedTokens[key]) } : undefined),
        }),
      };
    }
    if (table === 'token_credentials') {
      return {
        where: () => ({ first: async () => undefined, update: async () => 1 }),
        insert: async () => 1,
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('token-health checkGBP', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GBP_')) delete process.env[key];
    }
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'live-access-token', expires_in: 3599 }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test('healthy when refresh token comes from system_settings (no env token)', async () => {
    process.env.GBP_CLIENT_ID_LWR = 'client-id';
    process.env.GBP_CLIENT_SECRET_LWR = 'client-secret';
    mockDb({ storedTokens: { 'gbp.oauth_tokens.bradenton': { refresh_token: 'stored-rt' } } });

    const result = await tokenHealth.checkSingle('gbp_lwr');

    expect(result.status).toBe('healthy');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = global.fetch.mock.calls[0][1].body;
    expect(body.get('refresh_token')).toBe('stored-rt');
  });

  test('falls back to the legacy env refresh token when no stored token exists', async () => {
    process.env.GBP_CLIENT_ID_PARRISH = 'client-id';
    process.env.GBP_CLIENT_SECRET_PARRISH = 'client-secret';
    process.env.GBP_REFRESH_TOKEN_PARRISH = 'env-rt';
    mockDb();

    const result = await tokenHealth.checkSingle('gbp_parrish');

    expect(result.status).toBe('healthy');
    const body = global.fetch.mock.calls[0][1].body;
    expect(body.get('refresh_token')).toBe('env-rt');
  });

  test('not_configured with connect guidance when client creds exist but no token anywhere', async () => {
    process.env.GBP_CLIENT_ID_VENICE = 'client-id';
    process.env.GBP_CLIENT_SECRET_VENICE = 'client-secret';
    mockDb();

    const result = await tokenHealth.checkSingle('gbp_venice');

    expect(result.status).toBe('not_configured');
    expect(result.lastError).toContain('Not connected');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('not_configured listing missing client credentials', async () => {
    mockDb({ storedTokens: { 'gbp.oauth_tokens.sarasota': { refresh_token: 'stored-rt' } } });

    const result = await tokenHealth.checkSingle('gbp_sarasota');

    expect(result.status).toBe('not_configured');
    expect(result.lastError).toContain('GBP_CLIENT_ID_SARASOTA');
    expect(result.lastError).toContain('GBP_CLIENT_SECRET_SARASOTA');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('expired when Google rejects the stored refresh token', async () => {
    process.env.GBP_CLIENT_ID_LWR = 'client-id';
    process.env.GBP_CLIENT_SECRET_LWR = 'client-secret';
    mockDb({ storedTokens: { 'gbp.oauth_tokens.bradenton': { refresh_token: 'revoked-rt' } } });
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'invalid_grant', error_description: 'Token has been revoked.' }),
    });

    const result = await tokenHealth.checkSingle('gbp_lwr');

    expect(result.status).toBe('expired');
    expect(result.lastError).toContain('revoked');
  });
});
