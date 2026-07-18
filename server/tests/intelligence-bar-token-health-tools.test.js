/**
 * Integration token-health tool — unit tests with a mocked TokenHealthService.
 * Read-only contract: unhealthy-first ordering, ISO timestamps, token VALUES
 * never present (the service never returns them, and the mapper only passes
 * whitelisted fields), failures as { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockGetAll = jest.fn();
jest.mock('../services/token-health', () => ({ getAll: (...args) => mockGetAll(...args) }));

const { executeTokenHealthTool } = require('../services/intelligence-bar/token-health-tools');

describe('intelligence bar token health tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('unknown tool name returns an error result', async () => {
    const result = await executeTokenHealthTool('rotate_token');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('maps rows, sorts unhealthy first, and counts not_configured as unhealthy', async () => {
    const verified = new Date('2026-07-17T08:00:00Z');
    mockGetAll.mockResolvedValueOnce([
      { platform: 'stripe', token_type: 'api_key', status: 'healthy', last_verified_at: verified, expires_at: null, last_error: null, env_var_name: 'STRIPE_SECRET_KEY' },
      { platform: 'gbp_venice', token_type: 'oauth', status: 'error', last_verified_at: verified, expires_at: new Date('2026-07-20T00:00:00Z'), last_error: 'OAuth refresh failed', env_var_name: null },
      // A never-authorized integration is exactly what "is everything
      // connected?" must surface — not_configured counts as unhealthy.
      { platform: 'meta_ads', token_type: 'oauth', status: 'not_configured', last_verified_at: null, expires_at: null, last_error: null, env_var_name: null },
      { platform: 'twilio', token_type: 'api_key', status: 'expired', last_verified_at: verified, expires_at: null, last_error: null, env_var_name: 'TWILIO_AUTH_TOKEN' },
    ]);

    const result = await executeTokenHealthTool('get_integration_token_health');
    expect(result.error).toBeUndefined();
    expect(result.platforms.map(p => p.platform)).toEqual(['gbp_venice', 'twilio', 'meta_ads', 'stripe']);
    expect(result.platforms[0].last_error).toBe('OAuth refresh failed');
    expect(result.platforms[0].expires_at).toBe('2026-07-20T00:00:00.000Z');
    expect(result.platforms[3].last_verified_at).toBe('2026-07-17T08:00:00.000Z');
    expect(result.total).toBe(4);
    expect(result.unhealthy).toBe(3);
  });

  test('empty table returns a benign shape', async () => {
    mockGetAll.mockResolvedValueOnce([]);
    const result = await executeTokenHealthTool('get_integration_token_health');
    expect(result.error).toBeUndefined();
    expect(result.platforms).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('service failure surfaces as { error }, never a throw', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('db down'));
    const result = await executeTokenHealthTool('get_integration_token_health');
    expect(result.error).toMatch(/db down/);
  });
});
