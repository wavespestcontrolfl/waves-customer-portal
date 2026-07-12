/**
 * GrowthBook tools — unit tests with a mocked GrowthBook API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), experiment/feature mapping, and { error }
 * on auth failure. There is deliberately no mutation surface to test —
 * GrowthBook changes happen only in its UI by the operator.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GB_ENV_KEYS = ['GROWTHBOOK_API_KEY', 'GROWTHBOOK_API_BASE'];

const savedEnv = {};
let executeGrowthbookTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of GB_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of GB_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of GB_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeGrowthbookTool } = require('../services/intelligence-bar/growthbook-tools'));
});

describe('intelligence bar GrowthBook tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeGrowthbookTool('get_growthbook_experiments', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/GROWTHBOOK_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_read-only_x';
    const result = await executeGrowthbookTool('update_feature', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_growthbook_experiments maps status and variations', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_read-only_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      hasMore: false,
      experiments: [{
        id: 'exp_hub',
        name: 'Hub variants',
        status: 'running',
        hypothesis: 'Variant B lifts calls',
        variations: [{ name: 'Control' }, { name: 'Variant B' }],
        archived: false,
      }],
    }));

    const result = await executeGrowthbookTool('get_growthbook_experiments', {});
    expect(result.error).toBeUndefined();
    expect(result.experiments).toEqual([{
      id: 'exp_hub',
      name: 'Hub variants',
      status: 'running',
      hypothesis: 'Variant B lifts calls',
      variations: ['Control', 'Variant B'],
      archived: false,
    }]);
  });

  test('get_growthbook_features maps flags with defaults and tags', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_read-only_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      hasMore: true,
      features: [{ id: 'pricing-hub', valueType: 'boolean', defaultValue: 'false', tags: ['pricing'], archived: false }],
    }));

    const result = await executeGrowthbookTool('get_growthbook_features', { limit: 5 });
    expect(result.error).toBeUndefined();
    expect(result.features[0]).toEqual({
      id: 'pricing-hub', value_type: 'boolean', default_value: 'false', environments: {}, tags: ['pricing'], archived: false,
    });
    expect(result.has_more).toBe(true);
    expect(String(global.fetch.mock.calls[0][0])).toContain('limit=5');
  });

  test('get_growthbook_features surfaces per-environment enabled + default (production may differ from base)', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_read-only_x';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      hasMore: false,
      features: [{
        id: 'pricing-hub',
        valueType: 'boolean',
        defaultValue: 'false',
        environments: {
          production: { enabled: true, defaultValue: 'true' },
          dev: { enabled: false },
        },
        tags: [],
        archived: false,
      }],
    }));

    const result = await executeGrowthbookTool('get_growthbook_features', {});
    expect(result.error).toBeUndefined();
    expect(result.features[0].default_value).toBe('false');
    expect(result.features[0].environments).toEqual({
      production: { enabled: true, default_value: 'true' },
      dev: { enabled: false, default_value: null },
    });
  });

  test('auth rejection surfaces a key hint as { error }, never a throw', async () => {
    process.env.GROWTHBOOK_API_KEY = 'bad';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));

    const result = await executeGrowthbookTool('get_growthbook_experiments', {});
    expect(result.error).toMatch(/GROWTHBOOK_API_KEY/);
  });
});
