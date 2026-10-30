/**
 * Gap-rule admin routes (GATE_ADS_GAP_RULE): GET /gap-rule, PUT /gap-rule/settings,
 * POST + DELETE /campaigns/:id/hold. Pins: every route answers 404 gap_rule_off
 * while the gate is off; PUT validates and merges into ad_targets.metadata
 * without dropping other keys; POST hold applies the mode with setMode
 * (requireLivePush) FIRST and saves the hold only after it succeeds.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockGapMode = 'shadow';
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  adsGapRuleMode: () => mockGapMode,
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'admin-1'; return next(); },
  };
});
jest.mock('../services/ads/google-ads', () => ({ isConfigured: jest.fn(() => true), updateBudget: jest.fn() }));

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
let campaignRow;
let targetsRow;
let lastSetting;
let targetsWrites;
let campaignWrites;

const mockDb = jest.fn((table) => {
  if (table === 'ad_campaigns') {
    const b = {
      where: () => b,
      forUpdate: () => b,
      first: () => Promise.resolve(campaignRow),
      update: (patch) => {
        campaignWrites.push(patch);
        campaignRow = { ...campaignRow, ...patch, metadata: JSON.parse(patch.metadata) };
        return { returning: () => Promise.resolve([campaignRow]) };
      },
      then: (r, j) => Promise.resolve(campaignRow ? [campaignRow] : []).then(r, j),
    };
    return b;
  }
  if (table === 'ad_targets') {
    const b = {
      forUpdate: () => b,
      where: () => b,
      first: () => Promise.resolve(targetsRow),
      update: (patch) => { targetsWrites.push(patch); targetsRow = { ...targetsRow, metadata: JSON.parse(patch.metadata) }; return Promise.resolve(1); },
      insert: (row) => { targetsWrites.push(row); targetsRow = { id: 't1', metadata: JSON.parse(row.metadata) }; return Promise.resolve([1]); },
    };
    return b;
  }
  if (table === 'system_settings') {
    return { where: () => ({ first: () => Promise.resolve(lastSetting) }) };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});
mockDb.transaction = (cb) => cb(mockDb);
mockDb.fn = { now: () => 'NOW()' };
mockDb.raw = jest.fn((s) => s);
jest.mock('../models/db', () => mockDb);

const express = require('express');
const BudgetManager = require('../services/ads/budget-manager');
const { etDateString, addETDays } = require('../utils/datetime-et');
const adsRouter = require('../routes/admin-ads');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/admin/ads${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const today = () => etDateString(new Date());
const inDays = (n) => etDateString(addETDays(new Date(), n));
const evaluation = {
  settings: { ...BudgetManager.GAP_RULE_DEFAULTS },
  window_start: '2026-10-30',
  window_end: '2026-11-05',
  days: [{ date: '2026-10-30', stops: 4, techs: 1, limit: 9, open: 5 }, { date: '2026-10-31', stops: 2, techs: 1, limit: 8, open: 6 }],
  total_open: 11,
  total_limit: 17,
  total_stops: 6,
  decision: 'base',
  capacity_pct: 35,
  reason: 'Gap rule: 11 open stops',
};

beforeEach(() => {
  jest.restoreAllMocks();
  mockGapMode = 'shadow';
  campaignRow = {
    id: CAMPAIGN_ID, campaign_name: 'Waves Pest Control - GBP Search', platform: 'google_ads', status: 'active',
    budget_mode: 'stop', daily_budget_current: '0.05', daily_budget_base: '5', metadata: { keep: 'me' },
  };
  targetsRow = { id: 't1', metadata: { other: 'keep' } };
  lastSetting = null;
  targetsWrites = [];
  campaignWrites = [];
  jest.spyOn(BudgetManager, 'evaluateGapRule').mockResolvedValue(evaluation);
  jest.spyOn(BudgetManager, 'setMode').mockResolvedValue({ campaign: 'x', previousMode: 'stop', newMode: 'base', newBudget: 5, googleAdsUpdated: true });
});

describe('gate off', () => {
  test.each([
    ['GET', '/gap-rule'],
    ['PUT', '/gap-rule/settings'],
    ['POST', `/campaigns/${CAMPAIGN_ID}/hold`],
    ['DELETE', `/campaigns/${CAMPAIGN_ID}/hold`],
  ])('%s %s answers 404 gap_rule_off and changes nothing', async (method, path) => {
    mockGapMode = 'off';
    const res = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : { mode: 'base', until: inDays(1), window_days: 5 });
    expect(res).toEqual({ status: 404, body: { error: 'gap_rule_off' } });
    expect(BudgetManager.setMode).not.toHaveBeenCalled();
    expect(targetsWrites).toHaveLength(0);
    expect(campaignWrites).toHaveLength(0);
  });
});

describe('GET /gap-rule', () => {
  test('returns the window, the decision, the campaigns with their active hold, and the last run', async () => {
    campaignRow.metadata = { budget_hold: { mode: 'base', until: inDays(2), set_at: '2026-10-29T12:00:00Z', set_by: 'admin-1', reason: 'x' } };
    lastSetting = { value: JSON.stringify({ at: '2026-10-29T22:00:00Z', mode: 'shadow', total_open: 9, decision: 'base', days: [], campaigns: [] }) };
    const res = await call('GET', '/gap-rule');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('shadow');
    expect(res.body.settings).toEqual(evaluation.settings);
    expect(res.body.window).toMatchObject({ start: '2026-10-30', end: '2026-11-05', total_open: 11, total_limit: 17, total_stops: 6 });
    expect(res.body.window.days[0]).toEqual({ date: '2026-10-30', weekday: 'Fri', stops: 4, techs: 1, limit: 9, open: 5 });
    expect(res.body.window.days[1].weekday).toBe('Sat');
    expect(res.body.decision.mode).toBe('base');
    expect(res.body.decision.reason).toEqual(expect.any(String));
    expect(res.body.campaigns).toEqual([{
      id: CAMPAIGN_ID,
      campaign_name: 'Waves Pest Control - GBP Search',
      budget_mode: 'stop',
      daily_budget_current: '0.05',
      daily_budget_base: '5',
      hold: { mode: 'base', until: inDays(2), set_at: '2026-10-29T12:00:00Z', set_by: 'admin-1' },
    }]);
    expect(res.body.last_run).toEqual({ at: '2026-10-29T22:00:00Z', mode: 'shadow', total_open: 9, decision: 'base' });
  });

  test('live mode is reported; an expired hold and a missing last run read as null', async () => {
    mockGapMode = 'live';
    campaignRow.metadata = { budget_hold: { mode: 'base', until: inDays(-1) } };
    BudgetManager.evaluateGapRule.mockResolvedValue({ ...evaluation, decision: 'keep' });
    const res = await call('GET', '/gap-rule');
    expect(res.body.mode).toBe('live');
    expect(res.body.decision.mode).toBe('keep');
    expect(res.body.campaigns[0].hold).toBeNull();
    expect(res.body.last_run).toBeNull();
  });
});

describe('PUT /gap-rule/settings', () => {
  test('merges a subset into ad_targets.metadata.gap_rule and keeps other metadata keys', async () => {
    const res = await call('PUT', '/gap-rule/settings', { weekday_limit: 10, run_at_open: 8 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ ...BudgetManager.GAP_RULE_DEFAULTS, weekday_limit: 10, run_at_open: 8 });
    expect(JSON.parse(targetsWrites[0].metadata)).toEqual({ other: 'keep', gap_rule: res.body.settings });
  });

  test('creates the targets row when there is none', async () => {
    targetsRow = undefined;
    const res = await call('PUT', '/gap-rule/settings', { window_days: 5 });
    expect(res.status).toBe(200);
    expect(JSON.parse(targetsWrites[0].metadata)).toEqual({ gap_rule: { ...BudgetManager.GAP_RULE_DEFAULTS, window_days: 5 } });
  });

  test.each([
    [{ weekday_limit: 31 }, /weekday_limit/],
    [{ window_days: 0 }, /window_days/],
    [{ run_at_open: 'six' }, /run_at_open/],
    [{ bogus: 1 }, /bogus/],
    [{ stop_below_open: 7 }, /stop_below_open/],
    [{}, /at least one/],
  ])('400 for %j', async (body, message) => {
    const res = await call('PUT', '/gap-rule/settings', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(targetsWrites).toHaveLength(0);
  });
});

describe('POST /campaigns/:id/hold', () => {
  test('applies the mode first with a live push, then saves the hold and keeps other metadata', async () => {
    const until = inDays(5);
    const res = await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'base', until });
    expect(res.status).toBe(200);
    expect(BudgetManager.setMode).toHaveBeenCalledWith(CAMPAIGN_ID, 'base', `Hold: base until ${until} (set in the portal)`, { requireLivePush: true, requireActive: true, trigger: 'manual' });
    expect(res.body.hold).toMatchObject({ mode: 'base', until, set_by: 'admin-1', set_at: expect.any(String) });
    const saved = JSON.parse(campaignWrites[0].metadata);
    expect(saved.keep).toBe('me');
    expect(saved.budget_hold).toEqual(res.body.hold);
    expect(res.body.campaign.id).toBe(CAMPAIGN_ID);
  });

  test('a hold on the mode the campaign is already in saves the hold without a push', async () => {
    const res = await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'stop', until: inDays(1) });
    expect(res.status).toBe(200);
    expect(BudgetManager.setMode).not.toHaveBeenCalled();
    expect(campaignWrites).toHaveLength(1);
  });

  test.each([
    ['live_push_unavailable', 422],
    ['live_push_failed', 502],
    ['live_push_rolled_back', 502],
    ['live_push_ambiguous', 502],
    ['mode_conflict', 409],
    ['campaign_inactive', 422],
  ])('setMode error %s maps to %i and saves no hold', async (code, status) => {
    BudgetManager.setMode.mockRejectedValue(Object.assign(new Error('refused'), { code }));
    const res = await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'base', until: inDays(3) });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ applied: false, error: 'refused' });
    expect(campaignWrites).toHaveLength(0);
  });

  test('a race where another writer already made the change still saves the hold', async () => {
    BudgetManager.setMode.mockRejectedValue(Object.assign(new Error('already'), { code: 'mode_noop' }));
    const res = await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'base', until: inDays(3) });
    expect(res.status).toBe(200);
    expect(campaignWrites).toHaveLength(1);
  });

  test.each([
    ['bad mode', { mode: 'spent', until: inDays(1) }],
    ['no date', { mode: 'base' }],
    ['not a real date', { mode: 'base', until: '2026-02-30' }],
    ['past date', { mode: 'base', until: inDays(-1) }],
    ['too far', { mode: 'base', until: inDays(61) }],
    ['not ISO', { mode: 'base', until: '11/05/2026' }],
  ])('400 for %s', async (_label, body) => {
    const res = await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, body);
    expect(res.status).toBe(400);
    expect(BudgetManager.setMode).not.toHaveBeenCalled();
    expect(campaignWrites).toHaveLength(0);
  });

  test('today and today + 60 are accepted', async () => {
    expect((await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'stop', until: today() })).status).toBe(200);
    expect((await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'stop', until: inDays(60) })).status).toBe(200);
  });

  test('404 for an unknown campaign, 400 for a non-Google campaign', async () => {
    campaignRow = undefined;
    expect((await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'base', until: inDays(1) })).status).toBe(404);
    expect((await call('POST', '/campaigns/not-a-uuid/hold', { mode: 'base', until: inDays(1) })).status).toBe(404);
    campaignRow = { id: CAMPAIGN_ID, platform: 'facebook', status: 'active', metadata: null };
    expect((await call('POST', `/campaigns/${CAMPAIGN_ID}/hold`, { mode: 'base', until: inDays(1) })).status).toBe(400);
    expect(BudgetManager.setMode).not.toHaveBeenCalled();
  });
});

describe('DELETE /campaigns/:id/hold', () => {
  test('removes only the hold and keeps the other metadata', async () => {
    campaignRow.metadata = { keep: 'me', budget_hold: { mode: 'base', until: inDays(3) } };
    const res = await call('DELETE', `/campaigns/${CAMPAIGN_ID}/hold`);
    expect(res.status).toBe(200);
    expect(res.body.hold).toBeNull();
    expect(JSON.parse(campaignWrites[0].metadata)).toEqual({ keep: 'me' });
    expect(BudgetManager.setMode).not.toHaveBeenCalled();
  });

  test('404 for an unknown campaign', async () => {
    campaignRow = undefined;
    expect((await call('DELETE', `/campaigns/${CAMPAIGN_ID}/hold`)).status).toBe(404);
  });
});
