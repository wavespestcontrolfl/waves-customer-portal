/**
 * set_growthbook_feature_environment (owner ruling 2026-09-28, Decision 5) — PREVIEW ONLY.
 * Mocked GrowthBook API: the preview reads GET /api/v1/features/{id} and shows
 * the environment's current state; the toggle endpoint is never called, and
 * confirmed:true acts only on the _verified_growthbook_* pins.
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

const propose = (input) => executeGrowthbookTool('set_growthbook_feature_environment', { feature_id: 'pricing-hub', enabled: true, ...input });

describe('set_growthbook_feature_environment', () => {
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
    expect(result.tool).toBe('set_growthbook_feature_environment');
    expect(result.feature).toBe('pricing-hub');
    expect(result.environment).toBe('production');
    expect(result.current_state).toBe('disabled in production');
    expect(result.new_state).toBe('enabled in production');
    expect(result.change).toBe('Feature pricing-hub: disabled in production → enabled in production');
    expect(result.default_value).toBe('false');
    // Enabled is not "serving true" (Codex r1 on #5489): the card says what
    // the environment will actually serve.
    expect(result.effect_note).toMatch(/serves the feature's default value \(false\) plus ALL 2 targeting rule/);
    expect(result.effect_note).toMatch(/does not by itself make it serve true/);
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
    expect(result.current_state).toBe('enabled in dev');
    expect(result.new_state).toBe('disabled in dev');
    expect(result.effect_note).toMatch(/fall back to the default written in their own code/);
  });

  test('no-op: already in the requested state returns a plain answer, no card', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody()));
    const result = await propose({ enabled: false });
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('already_set');
    expect(result.error).toBeUndefined();
    expect(result.already_set).toBe(true);
    expect(result.message).toMatch(/already disabled in production/);
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

  // ── commit path: acts only on the _verified_growthbook_* pins ──
  const PINS = {
    _verified_growthbook_feature_id: 'pricing-hub',
    _verified_growthbook_environment: 'production',
    _verified_growthbook_prior_enabled: false,
    _verified_growthbook_feature_updated: '2026-09-01T12:00:00.000Z',
    _verified_growthbook_revision: 7,
  };
  const commit = (pins = {}) => executeGrowthbookTool('set_growthbook_feature_environment', {
    feature_id: 'forged-from-input', environment: 'dev', enabled: false, confirmed: true, ...PINS, ...pins,
  });
  const posts = () => global.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');

  // Codex r1 on #5514 (P1): enabling puts every rule live, so the card lists
  // each one in full — what it serves, to whom, how much, when — and the
  // default value untruncated.
  test('the preview lists every targeting rule in full, and the full default value', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    const longDefault = JSON.stringify({ tiers: Array.from({ length: 40 }, (_, i) => `tier-${i}`) });
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody({
      environments: {
        production: {
          enabled: false,
          defaultValue: longDefault,
          rules: [
            { type: 'force', value: 'true', condition: '{"email":{"$regex":"@wavespestcontrol.com$"}}', description: 'staff only' },
            { type: 'rollout', value: 'true', coverage: 0.25 },
            { type: 'experiment', variations: [{ value: 'false' }, { value: 'true' }], weights: [0.5, 0.5], enabled: false },
          ],
        },
      },
    })));
    const result = await propose({});
    expect(result.default_value).toBe(longDefault);
    expect(Object.keys(result.rules)).toEqual(['rule_1', 'rule_2', 'rule_3']);
    expect(result.rules.rule_1).toMatch(/force · "staff only" · serves "?true"? · when .*wavespestcontrol/);
    expect(result.rules.rule_2).toMatch(/rollout · serves "?true"? · to 25% of matching traffic/);
    expect(result.rules.rule_3).toMatch(/experiment \(this rule is turned off\) · variations .* · weights \[0\.5,0\.5\]/);
    expect(result.effect_note).toMatch(/ALL 3 targeting rule\(s\) listed on this card/);
  });

  test('confirmed without pins refuses with missing_verified_pin and no network call', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    const result = await propose({ confirmed: true });
    expect(result.code).toBe('missing_verified_pin');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('confirmed: toggles the pinned feature + environment via the v2 endpoint (never the call input)', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(featureBody()))
      .mockResolvedValueOnce(jsonResponse({ feature: {} }));
    const result = await commit();
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    const [[url, init]] = posts();
    expect(url).toBe('https://api.growthbook.io/api/v2/features/pricing-hub/toggle');
    const body = JSON.parse(init.body);
    // Exactly the switch the card showed — no undisclosed reason/comment.
    expect(body).toEqual({ environments: { production: true } });
    expect(JSON.stringify(global.fetch.mock.calls)).not.toContain('forged-from-input');
  });

  test.each([
    ['edited in the GrowthBook UI (dateUpdated moved)', { dateUpdated: '2026-10-01T09:00:00.000Z' }],
    ['a new revision', { revision: { version: 8 } }],
    ['archived', { archived: true }],
    ['the environment was already enabled', { environments: { production: { enabled: true, defaultValue: 'false', rules: [] } } }],
    ['the environment is gone', { environments: { dev: { enabled: true } } }],
  ])('confirmed but %s since the card: target_changed, no toggle', async (_label, overrides) => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse(featureBody(overrides)));
    const result = await commit();
    expect(result.code).toBe('target_changed');
    expect(result.preview_changed).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  test('confirmed but the feature was deleted: target_changed, no toggle', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const result = await commit();
    expect(result.code).toBe('target_changed');
    expect(posts()).toHaveLength(0);
  });

  // Pass-1 terminal review: a dispatched toggle with no clear answer may have
  // applied, so it is outcome_unknown — never "failed".
  test.each([
    ['a network drop', () => Promise.reject(new Error('socket hang up'))],
    ['an HTTP 503', () => Promise.resolve(jsonResponse({}, 503))],
  ])('the toggle ends in %s: outcome_unknown, not failed', async (_label, answer) => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(featureBody()))
      .mockImplementationOnce(answer);
    const result = await commit();
    expect(result.outcome_unknown).toBe(true);
    expect(result.error).toBeUndefined();
    const { executionOutcome } = require('../services/intelligence-bar/outcomes');
    expect(executionOutcome(result)).toBe('outcome_unknown');
  });

  // Pass-2: GrowthBook maps an error raised AFTER the toggle applied to HTTP
  // 400, so a 4xx other than a permission refusal is not proof either.
  test('a 400 on the toggle is outcome_unknown (it may have applied)', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(featureBody()))
      .mockResolvedValueOnce(jsonResponse({ message: 'audit failed' }, 400));
    const result = await commit();
    expect(result.outcome_unknown).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('a key without Publish access on the toggle: write_access_required, no success', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    global.fetch
      .mockResolvedValueOnce(jsonResponse(featureBody()))
      .mockResolvedValueOnce(jsonResponse({ message: 'Forbidden' }, 403));
    const result = await commit();
    expect(result.success).toBeUndefined();
    expect(result.code).toBe('write_access_required');
    expect(result.error).toMatch(/Publish access/);
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
