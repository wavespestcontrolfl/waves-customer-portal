/**
 * Weekly BI briefing — get_experiment_results.
 *
 * Pins the shape the briefing prompt relies on: only RUNNING experiments,
 * one row per goal metric × variation (users / conversions / rate / chance to
 * beat control), the readiness note that keeps a 7-user split from being
 * reported as a result, an SRM flag, a never-refreshed experiment reported
 * (not thrown), and the unconfigured / failed paths answering plainly.
 * GrowthBook is reached only through the shared gbGet (fetch stubbed here).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const listPayload = {
  experiments: [
    { id: 'exp_run', name: 'Ask Waves auto-prompt', trackingKey: 'auto_prompt', status: 'running', archived: false, hypothesis: 'Prompting lifts leads', phases: [{ dateStarted: '2026-09-06T06:03:00.000Z' }] },
    { id: 'exp_draft', name: 'Recovery holdback', trackingKey: 'booking-abandon-recovery', status: 'draft', archived: false, phases: [] },
    { id: 'exp_none', name: 'Never refreshed', trackingKey: 'never', status: 'running', archived: false, phases: [{ dateStarted: '2026-09-01T00:00:00.000Z' }] },
  ],
};
const resultsPayload = {
  result: {
    dateUpdated: '2026-09-07T00:13:31.577Z',
    results: [{
      dimension: '', totalUsers: 7, checks: { srm: 0.7 },
      metrics: [{ metricId: 'met_lead', metricName: 'Lead Submitted (anon visitor)', variations: [
        { variationId: 'v0', variationName: 'Control', users: 3, analyses: [{ numerator: 2, mean: 0.6667, percentChange: 0, ciLow: 0, ciHigh: 0, chanceToBeatControl: 0 }] },
        { variationId: 'v1', variationName: 'Auto-prompt', users: 4, analyses: [{ numerator: 0, mean: 0, percentChange: -1, ciLow: -1, ciHigh: 0.2, chanceToBeatControl: 0.5, errorMessage: 'ZERO_NEGATIVE_VARIANCE' }] },
      ] }],
    }],
  },
};

function stubFetch() {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.endsWith('/api/v1/experiments?limit=50')) return ok(listPayload);
    if (u.includes('/experiments/exp_run/results')) return ok(resultsPayload);
    if (u.includes('/experiments/exp_none/results')) return ok({ message: 'No results found for that experiment' }, 404);
    return ok({ message: 'unexpected ' + u }, 500);
  });
}

describe('getExperimentResultsSummary', () => {
  beforeEach(() => { process.env.GROWTHBOOK_API_KEY = 'secret_test'; stubFetch(); jest.resetModules(); });
  afterEach(() => { delete process.env.GROWTHBOOK_API_KEY; });

  test('running experiments only, one row per metric × variation, readiness + srm', async () => {
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
    expect(run.metrics).toHaveLength(1);
    expect(run.metrics[0].metric).toBe('Lead Submitted (anon visitor)');
    expect(run.metrics[0].variations).toEqual([
      { name: 'Control', users: 3, conversions: 2, rate: 0.6667, percent_change: 0, ci: [0, 0], chance_to_beat_control: 0, note: null },
      { name: 'Auto-prompt', users: 4, conversions: 0, rate: 0, percent_change: -100, ci: [-100, 20], chance_to_beat_control: 0.5, note: 'ZERO_NEGATIVE_VARIANCE' },
    ]);
    // Never-refreshed experiment: reported, not thrown.
    const none = out.experiments[1];
    expect(none.readiness).toBe('no analysis yet');
    expect(none.metrics).toEqual([]);
    expect(none.results_error).toMatch(/HTTP 404/);
  });

  test('a fully powered experiment reads as enough traffic', async () => {
    resultsPayload.result.results[0].metrics[0].variations.forEach((v) => { v.users = 250; });
    const { getExperimentResultsSummary } = require('../services/intelligence-bar/growthbook-tools');
    const out = await getExperimentResultsSummary();
    expect(out.experiments[0].readiness).toBe('enough traffic to read');
    resultsPayload.result.results[0].metrics[0].variations[0].users = 3;
    resultsPayload.result.results[0].metrics[0].variations[1].users = 4;
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
