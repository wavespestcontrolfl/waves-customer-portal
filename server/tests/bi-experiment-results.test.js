/**
 * Weekly BI briefing — get_experiment_results.
 *
 * Pins the shape the briefing prompt relies on: only RUNNING experiments
 * across every page of the inventory, one row per goal metric × variation
 * (users / numerator / mean / chance to beat control, with the metric type so
 * a revenue goal is never read as conversions), the readiness note computed
 * over EVERY goal metric so a 7-user secondary can't hide behind a 250-user
 * primary, an SRM flag, a never-refreshed experiment (404) reported — while
 * any other results failure surfaces as the tool's error — and the
 * unconfigured / failed paths answering plainly. GrowthBook is reached only
 * through the shared gbGet (fetch stubbed here).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

// Two pages of inventory: the never-refreshed running experiment sits on page 2.
const listPage1 = {
  experiments: [
    { id: 'exp_run', name: 'Ask Waves auto-prompt', trackingKey: 'auto_prompt', status: 'running', archived: false, hypothesis: 'Prompting lifts leads', phases: [{ dateStarted: '2026-09-06T06:03:00.000Z' }] },
    { id: 'exp_draft', name: 'Recovery holdback', trackingKey: 'booking-abandon-recovery', status: 'draft', archived: false, phases: [] },
  ],
  hasMore: true,
};
const listPage2 = {
  experiments: [
    { id: 'exp_none', name: 'Never refreshed', trackingKey: 'never', status: 'running', archived: false, phases: [{ dateStarted: '2026-09-01T00:00:00.000Z' }] },
  ],
  hasMore: false,
};
const metricsPayload = { metrics: [{ id: 'met_lead', type: 'binomial' }, { id: 'met_rev', type: 'revenue' }], hasMore: false };
const resultsPayload = {
  result: {
    dateUpdated: '2026-09-07T00:13:31.577Z',
    results: [{
      dimension: '', totalUsers: 7, checks: { srm: 0.7 },
      metrics: [
        { metricId: 'met_lead', metricName: 'Lead Submitted (anon visitor)', variations: [
          { variationId: 'v0', variationName: 'Control', users: 3, analyses: [{ numerator: 2, mean: 0.6667, percentChange: 0, ciLow: 0, ciHigh: 0, chanceToBeatControl: 0 }] },
          { variationId: 'v1', variationName: 'Auto-prompt', users: 4, analyses: [{ numerator: 0, mean: 0, percentChange: -1, ciLow: -1, ciHigh: 0.2, chanceToBeatControl: 0.5, errorMessage: 'ZERO_NEGATIVE_VARIANCE' }] },
        ] },
        { metricId: 'met_rev', metricName: 'Customer Invoice Revenue', variations: [
          { variationId: 'v0', variationName: 'Control', users: 3, analyses: [{ numerator: 1250.5, mean: 416.83, percentChange: 0, ciLow: 0, ciHigh: 0, chanceToBeatControl: 0 }] },
          { variationId: 'v1', variationName: 'Auto-prompt', users: 4, analyses: [{ numerator: 900, mean: 225, percentChange: -0.46, ciLow: -0.9, ciHigh: 0.1, chanceToBeatControl: 0.2 }] },
        ] },
      ],
    }],
  },
};

function stubFetch() {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.endsWith('/api/v1/experiments?limit=100&offset=0')) return ok(listPage1);
    if (u.endsWith('/api/v1/experiments?limit=100&offset=100')) return ok(listPage2);
    if (u.includes('/api/v1/metrics?limit=100')) return ok(metricsPayload);
    if (u.includes('/experiments/exp_run/results')) return ok(resultsPayload);
    if (u.includes('/experiments/exp_none/results')) return ok({ message: 'No results found for that experiment' }, 404);
    return ok({ message: 'unexpected ' + u }, 500);
  });
}

describe('getExperimentResultsSummary', () => {
  beforeEach(() => { process.env.GROWTHBOOK_API_KEY = 'secret_test'; stubFetch(); jest.resetModules(); });
  afterEach(() => { delete process.env.GROWTHBOOK_API_KEY; });

  test('running experiments across every page, one row per metric × variation with the metric type, readiness + srm', async () => {
    const { getExperimentResultsSummary, MIN_USERS_PER_ARM } = require('../services/intelligence-bar/growthbook-tools');
    const out = await getExperimentResultsSummary();
    expect(out.running).toBe(2);
    expect(out.experiments.map((e) => e.id)).toEqual(['exp_run', 'exp_none']);
    const run = out.experiments[0];
    expect(run.tracking_key).toBe('auto_prompt');
    expect(run.started).toBe('2026-09-06T06:03:00.000Z');
    expect(run.total_users).toBe(7);
    expect(run.srm_warning).toBe(false);
    expect(run.readiness).toBe(`too early — smallest arm has 3 users (need ${MIN_USERS_PER_ARM}+)`);
    expect(run.metrics).toHaveLength(2);
    expect(run.metrics[0].metric).toBe('Lead Submitted (anon visitor)');
    expect(run.metrics[0].type).toBe('binomial');
    expect(run.metrics[0].variations).toEqual([
      { name: 'Control', users: 3, numerator: 2, mean: 0.6667, percent_change: 0, ci: [0, 0], chance_to_beat_control: 0, note: null },
      { name: 'Auto-prompt', users: 4, numerator: 0, mean: 0, percent_change: -100, ci: [-100, 20], chance_to_beat_control: 0.5, note: 'ZERO_NEGATIVE_VARIANCE' },
    ]);
    // Revenue keeps GrowthBook's semantics: numerator = aggregate, mean = per user.
    expect(run.metrics[1].type).toBe('revenue');
    expect(run.metrics[1].variations[0]).toMatchObject({ name: 'Control', users: 3, numerator: 1250.5, mean: 416.83 });
    // Never-refreshed experiment (404): reported, not thrown; it came from page 2.
    const none = out.experiments[1];
    expect(none.readiness).toBe('no analysis yet');
    expect(none.metrics).toEqual([]);
  });

  test('readiness is the smallest arm across EVERY goal metric', async () => {
    const m = resultsPayload.result.results[0].metrics;
    m[0].variations.forEach((v) => { v.users = 250; });
    // secondary metric still tiny
    const { getExperimentResultsSummary } = require('../services/intelligence-bar/growthbook-tools');
    let out = await getExperimentResultsSummary();
    expect(out.experiments[0].readiness).toBe('too early — smallest arm has 3 users (need 100+)');
    m[1].variations.forEach((v) => { v.users = 250; });
    jest.resetModules(); stubFetch();
    out = await require('../services/intelligence-bar/growthbook-tools').getExperimentResultsSummary();
    expect(out.experiments[0].readiness).toBe('enough traffic to read');
    m[0].variations[0].users = 3; m[0].variations[1].users = 4; m[1].variations[0].users = 3; m[1].variations[1].users = 4;
  });

  test('a non-404 results failure (auth / outage) propagates instead of reading as "no analysis yet"', async () => {
    stubFetch();
    const inner = global.fetch;
    global.fetch = jest.fn(async (url) => (String(url).includes('/experiments/exp_run/results') ? { ok: false, status: 503, json: async () => ({}) } : inner(url)));
    const { getExperimentResultsSummary } = require('../services/intelligence-bar/growthbook-tools');
    await expect(getExperimentResultsSummary()).rejects.toThrow(/HTTP 503/);
  });
});

describe('executeBITool(get_experiment_results)', () => {
  afterEach(() => { delete process.env.GROWTHBOOK_API_KEY; });

  test('unconfigured → plain configured:false, no fetch', async () => {
    delete process.env.GROWTHBOOK_API_KEY;
    global.fetch = jest.fn();
    jest.resetModules();
    const { executeBITool } = require('../services/bi-agent-tools');
    expect(await executeBITool('get_experiment_results', {})).toEqual({ configured: false, running: 0, experiments: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('configured → summary; a GrowthBook outage answers with error, never throws', async () => {
    process.env.GROWTHBOOK_API_KEY = 'secret_test';
    stubFetch();
    jest.resetModules();
    const { executeBITool } = require('../services/bi-agent-tools');
    const ok = await executeBITool('get_experiment_results', {});
    expect(ok.configured).toBe(true);
    expect(ok.running).toBe(2);
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const bad = await executeBITool('get_experiment_results', {});
    expect(bad).toEqual({ configured: true, error: expect.stringMatching(/HTTP 503/), running: 0, experiments: [] });
  });

  test('the tool is declared for the agent, with the readiness rule in its description', () => {
    const { BI_AGENT_CONFIG } = require('../services/bi-agent-config');
    const tool = BI_AGENT_CONFIG.tools.find((t) => t.name === 'get_experiment_results');
    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/readiness/);
    expect(BI_AGENT_CONFIG.system).toMatch(/get_experiment_results/);
  });
});
