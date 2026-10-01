/**
 * set_growthbook_feature (owner ruling 2026-09-28, Decision 5) — PREVIEW ONLY.
 * Mocked GrowthBook API: the preview reads GET /api/v1/features/{id} and shows
 * the environment's current state; the toggle endpoint is never called, and
 * confirmed:true refuses without any network call.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const GB_ENV_KEYS = ['GROWTHBOOK_API_KEY', 'GROWTHBOOK_API_BASE'];
const savedEnv = {};
let executeGrowthbookTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function featureBody(overrides = {}) {
  return {
    feature: {
      id: 'pricing-hub',
      archived: false,
      valueType: 'boolean',
      defaultValue: 'false',
      dateUpdated: '2026-09-01T12:00:00.000Z',
      revision: { version: 7 },
      environments: {
        production: { enabled: false, defaultValue: 'false', rules: [{ type: 'force' }, { type: 'rollout' }] },
        dev: { enabled: true, defaultValue: 'true', rules: [] },
      },
      ...overrides,
    },
  };
}

beforeAll(() => { for (const key of GB_ENV_KEYS) savedEnv[key] = process.env[key]; });
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

const propose = (input) => executeGrowthbookTool('set_growthbook_feature', { feature_id: 'pricing-hub', enabled: true, ...input });

describe('set_growthbook_feature (preview only)', () => {
  test('missing key: configured:false, no error, no card, no network call', async () => {
    const result = await propose({});
    expect(result.configured).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('missing key also wins over confirmed:true', async () => {
    const result = await propose({ confirmed: true });
    expect(result.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preview shows current state, new state, default value, rule count and the pins; only a GET is made', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody()));
    const result = await propose({});
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.tool).toBe('set_growthbook_feature');
    expect(result.feature).toBe('pricing-hub');
    expect(result.environment).toBe('production');
    expect(result.current_state).toBe('OFF');
    expect(result.new_state).toBe('ON');
    expect(result.change).toBe('Feature pricing-hub in production: OFF → ON');
    expect(result.default_value).toBe('false');
    expect(result.rule_count).toBe(2);
    expect(result.prior_enabled).toBe(false);
    expect(result.feature_version).toBe('2026-09-01T12:00:00.000Z');
    expect(result.revision_version).toBe(7);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.growthbook.io/api/v1/features/pricing-hub');
    expect(init.method).toBeUndefined(); // a plain GET
    expect(String(url)).not.toMatch(/toggle/);
  });

  test('another environment can be named and defaults to production', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody()));
    const result = await propose({ environment: 'dev', enabled: false });
    expect(result.environment).toBe('dev');
    expect(result.current_state).toBe('ON');
    expect(result.new_state).toBe('OFF');
  });

  test('no-op: already in the requested state returns a plain answer, no card', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody()));
    const result = await propose({ enabled: false });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_set');
    expect(result.error).toMatch(/already OFF in production/);
  });

  test('an unknown environment is refused with the real environment names', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody()));
    const result = await propose({ environment: 'staging' });
    expect(result.code).toBe('environment_not_found');
    expect(result.error).toMatch(/production, dev/);
  });

  test('a missing feature (404) is an answer, not an outage', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const result = await propose({});
    expect(result.code).toBe('feature_not_found');
    expect(result.preview).toBeUndefined();
  });

  test('an archived feature is refused', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody({ archived: true })));
    const result = await propose({});
    expect(result.code).toBe('feature_archived');
  });

  test.each([
    ['a feature id with a path separator', { feature_id: '../experiments' }, 'invalid_feature_id'],
    ['an empty feature id', { feature_id: '  ' }, 'invalid_feature_id'],
    ['an environment with odd characters', { environment: 'prod/../x' }, 'invalid_environment'],
    ['a non-boolean enabled', { enabled: 'yes' }, 'invalid_enabled'],
  ])('%s is refused before any network call', async (_label, input, code) => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    const result = await propose(input);
    expect(result.code).toBe(code);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('confirmed:true refuses (no commit path yet) and the toggle endpoint is never called', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    const result = await propose({ confirmed: true });
    expect(result.error).toMatch(/cannot be committed yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a rejected key surfaces as { error } and logs only the tool name', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 401));
    const result = await propose({});
    expect(result.error).toMatch(/rejected the key/);
    const logger = require('../services/logger');
    for (const call of logger.error.mock.calls) expect(JSON.stringify(call)).not.toContain('pricing-hub');
  });
});
