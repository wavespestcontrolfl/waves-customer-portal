/**
 * POST /api/admin/ads/advisor/apply — honest apply contract.
 *
 * The advisor "Apply" button previously always reported success even when the
 * server took no action. These pin that:
 *  - budget/mode recs resolve the campaign (id preferred, name fallback) and
 *    apply via setBudget/setMode, returning applied:true and counting the action;
 *  - an unresolvable campaign or a missing/invalid value returns 422 applied:false
 *    and does NOT increment the day's applied_count;
 *  - a name matching MORE than one campaign row is rejected (422) instead of
 *    mutating whichever row Postgres returns first;
 *  - a non-Google campaign (Meta/LSA — the advisor sees every platform) returns
 *    an honest 422 manual:true instead of a 500 from the budget manager;
 *  - a live Google push that was attempted and refused returns applied:false —
 *    a green "Applied" while Google kept the old budget is the original lie;
 *  - advisory-only actions (add_negative, SEO/GBP/bid) return applied:false with
 *    manual:true and are never counted;
 *  - the rule-based fallback advisor only emits executable recs: apply fields
 *    carry campaign_id + a concrete apply_value, and only for google_ads rows.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
  };
});

const mockSetBudget = jest.fn();
const mockSetMode = jest.fn();
jest.mock('../services/ads/budget-manager', () => ({
  setBudget: mockSetBudget,
  setMode: mockSetMode,
}));

let mockCampaignById = null;   // row returned by the id lookup (.first())
let mockNameMatches = [];      // rows returned by the name lookup (awaited builder)
const mockIncrement = jest.fn().mockResolvedValue(1);
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'ad_campaigns') {
    const b = {
      where: () => b,
      whereRaw: () => b,
      select: () => b,
      first: () => Promise.resolve(mockCampaignById),
      then: (r, j) => Promise.resolve(mockNameMatches).then(r, j),
    };
    return b;
  }
  if (table === 'ad_advisor_reports') {
    return { where: () => ({ increment: mockIncrement }) };
  }
  const b = { where: () => b, orderBy: () => b, first: () => Promise.resolve(null), then: (r, j) => Promise.resolve([]).then(r, j) };
  return b;
}));

const express = require('express');
const adsRouter = require('../routes/admin-ads');

let server; let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function apply(body) {
  const res = await fetch(`${baseUrl}/api/admin/ads/advisor/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCampaignById = null;
  mockNameMatches = [];
});

test('increase_budget resolves the campaign by name and applies', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads' }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String));
  expect(mockIncrement).toHaveBeenCalledTimes(1);
});

test('campaignId is preferred over the name lookup', async () => {
  mockCampaignById = { id: 'c-7', campaign_name: 'Pest Bradenton', platform: 'google_ads' };
  // A conflicting name match must not win when an id is present.
  mockNameMatches = [{ id: 'c-other', campaign_name: 'Pest Bradenton', platform: 'google_ads' }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 25, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignId: 'c-7', campaignName: 'Pest Bradenton', value: 25 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-7', 25, expect.any(String));
});

test('change_mode applies via setMode', async () => {
  mockNameMatches = [{ id: 'c-9', campaign_name: 'Lawn Sarasota', platform: 'google_ads' }];
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop', googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop' });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetMode).toHaveBeenCalledWith('c-9', 'stop', expect.any(String));
});

test('unlinked campaign (no live push attempted) still counts as applied', async () => {
  mockNameMatches = [{ id: 'c-9', campaign_name: 'Lawn Sarasota', platform: 'google_ads' }];
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop', googleAdsUpdated: false, livePushAttempted: false });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop' });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
});

test('a refused live Google push is NOT applied and not counted', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', platform_campaign_id: 'g-1' }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: false, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(502);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/Google Ads refused/);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('linked campaign whose push never ran is NOT applied (unconfigured client / no base)', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', platform_campaign_id: 'g-1' }];
  mockSetMode.mockResolvedValue({ campaign: 'Pest Bradenton', newMode: 'stop', googleAdsUpdated: false, livePushAttempted: false });

  const res = await apply({ action: 'change_mode', campaignName: 'Pest Bradenton', value: 'stop' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/could not run/);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('campaign id resolving to a different name than the card shows → 422', async () => {
  mockCampaignById = { id: 'c-7', campaign_name: 'Lawn Venice', platform: 'google_ads' };

  const res = await apply({ action: 'increase_budget', campaignId: 'c-7', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/mislabeled/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('AI budget more than 3× from the base is refused', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', daily_budget_base: 20 }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 3000 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/3× move/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('a sane budget within 3× of the base still applies', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', daily_budget_base: 20 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: false, livePushAttempted: false });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String));
});

test('applied_count increment failure does not flip a completed apply to an error', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads' }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });
  mockIncrement.mockRejectedValueOnce(new Error('db hiccup'));

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
});

test('non-Google campaign → 422 manual, budget manager never called', async () => {
  mockNameMatches = [{ id: 'c-m', campaign_name: 'Meta Retargeting', platform: 'facebook' }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Meta Retargeting', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.manual).toBe(true);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('name matching more than one campaign → 422, nothing mutated', async () => {
  mockNameMatches = [
    { id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads' },
    { id: 'c-2', campaign_name: 'Pest Bradenton', platform: 'facebook' },
  ];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/More than one campaign/);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('unresolvable campaign → 422 applied:false, not counted', async () => {
  const res = await apply({ action: 'increase_budget', campaignName: 'Ghost Campaign', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('budget rec with no concrete value → 422 applied:false', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads' }];
  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('change_mode with an invalid mode → 422 applied:false', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads' }];
  const res = await apply({ action: 'change_mode', campaignName: 'Pest Bradenton', value: 'turbo' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetMode).not.toHaveBeenCalled();
});

test('advisory-only action (add_negative) → applied:false manual, not counted', async () => {
  const res = await apply({ action: 'add_negative', value: ['cheap'] });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(false);
  expect(res.body.manual).toBe(true);
  expect(mockIncrement).not.toHaveBeenCalled();
});

describe('rule-based fallback recommendations are executable', () => {
  const advisor = require('../services/ads/campaign-advisor');

  const summary = (over = {}) => ({
    id: 'c-1', name: 'Pest Bradenton', platform: 'google_ads',
    dailyBudgetBase: 20, dailyBudgetCurrent: 20,
    last7d: { roas: 6, lostISBudget: 30 }, last30d: {}, trending: 'flat',
    ...over,
  });

  test('increase_budget fallback carries campaign_id and a concrete apply_value', () => {
    const advice = advisor.generateFallbackAdvice([summary()], { min_roas: 4 });
    const rec = advice.recommendations.find(r => r.apply_action === 'increase_budget');
    expect(rec).toBeDefined();
    expect(rec.campaign_id).toBe('c-1');
    expect(rec.apply_value).toBe(25); // $20 base +25%
    expect(rec.action).toMatch(/\$20 to \$25/);
  });

  test('increase_budget fallback with no known base budget stays advisory', () => {
    const advice = advisor.generateFallbackAdvice(
      [summary({ dailyBudgetBase: null, dailyBudgetCurrent: null })], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined();
    expect(rec.apply_value).toBeUndefined();
  });

  test('STOP fallback carries campaign_id + apply_value for google_ads only', () => {
    const advice = advisor.generateFallbackAdvice([
      summary({ last7d: { roas: 1, lostISBudget: 0 } }),
      summary({ id: 'c-m', name: 'Meta Retargeting', platform: 'facebook', last7d: { roas: 1, lostISBudget: 0 } }),
    ], { min_roas: 4 });

    const google = advice.recommendations.find(r => r.campaign === 'Pest Bradenton');
    expect(google.apply_action).toBe('change_mode');
    expect(google.apply_value).toBe('stop');
    expect(google.campaign_id).toBe('c-1');

    const meta = advice.recommendations.find(r => r.campaign === 'Meta Retargeting');
    expect(meta).toBeDefined();
    expect(meta.apply_action).toBeUndefined();
    expect(meta.campaign_id).toBeUndefined();
  });
});
