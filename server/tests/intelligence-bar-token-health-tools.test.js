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

  test('maps rows, sorts unhealthy first, and counts them', async () => {
    const verified = new Date('2026-07-17T08:00:00Z');
    mockGetAll.mockResolvedValueOnce([
      { platform: 'stripe', token_type: 'api_key', status: 'healthy', last_verified_at: verified, expires_at: null, last_error: null, env_var_name: 'STRIPE_SECRET_KEY' },
      { platform: 'meta_ads', token_type: 'oauth', status: 'broken', last_verified_at: verified, expires_at: null, last_error: 'OAuth token expired', env_var_name: null },
      { platform: 'gbp_venice', token_type: 'oauth', status: 'expiring', last_verified_at: verified, expires_at: new Date('2026-07-20T00:00:00Z'), last_error: null, env_var_name: null },
    ]);

    const result = await executeTokenHealthTool('get_integration_token_health');
    expect(result.error).toBeUndefined();
    expect(result.platforms.map(p => p.platform)).toEqual(['meta_ads', 'gbp_venice', 'stripe']);
    expect(result.platforms[0].last_error).toBe('OAuth token expired');
    expect(result.platforms[2].last_verified_at).toBe('2026-07-17T08:00:00.000Z');
    expect(result.platforms[1].expires_at).toBe('2026-07-20T00:00:00.000Z');
    expect(result.total).toBe(3);
    expect(result.unhealthy).toBe(2);
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
