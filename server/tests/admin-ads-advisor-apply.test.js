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

// campaign-advisor's normalizer/fallback check whether the Google Ads client
// can push (linked campaigns strip their Apply otherwise); mocked configured
// by default so executability tests exercise the other guards.
const mockAdsConfigured = jest.fn(() => true);
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: mockAdsConfigured,
  updateBudget: jest.fn(),
}));

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
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20, budget_mode: 'base' }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String), { requireLivePush: true, requireBaseMode: true, requireActive: true, requireBoundFactor: 3, trigger: 'advisor' });
  expect(mockIncrement).toHaveBeenCalledTimes(1);
});

const UUID_A = '11111111-2222-4333-8444-555555555555';

test('campaignId is preferred over the name lookup', async () => {
  mockCampaignById = { id: UUID_A, campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 };
  // A conflicting name match must not win when an id is present.
  mockNameMatches = [{ id: 'c-other', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 25, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignId: UUID_A, campaignName: 'Pest Bradenton', value: 25 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith(UUID_A, 25, expect.any(String), { requireLivePush: true, requireBaseMode: true, requireActive: true, requireBoundFactor: 3, trigger: 'advisor' });
});

test('a malformed (non-UUID) campaign_id falls back to the name lookup instead of a 500', async () => {
  mockCampaignById = null; // the uuid lookup must never run
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignId: 'c-not-a-uuid', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String), { requireLivePush: true, requireBaseMode: true, requireActive: true, requireBoundFactor: 3, trigger: 'advisor' });
});

test('change_mode applies via setMode', async () => {
  mockNameMatches = [{ id: 'c-9', campaign_name: 'Lawn Sarasota', platform: 'google_ads', status: 'active' }];
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop', googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop' });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetMode).toHaveBeenCalledWith('c-9', 'stop', expect.any(String), { requireLivePush: true, requireActive: true, trigger: 'advisor' });
});

test('unlinked campaign (no live push attempted) still counts as applied', async () => {
  mockNameMatches = [{ id: 'c-9', campaign_name: 'Lawn Sarasota', platform: 'google_ads', status: 'active' }];
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop', googleAdsUpdated: false, livePushAttempted: false });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop' });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
});

test('a refused live Google push is NOT applied and not counted', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', platform_campaign_id: 'g-1', daily_budget_base: 20 }];
  // requireLivePush pushes FIRST and throws before persisting anything.
  mockSetBudget.mockRejectedValue(Object.assign(new Error('Google Ads refused the budget update for "Pest Bradenton" — nothing was changed.'), { code: 'live_push_failed' }));

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(502);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/Google Ads refused/);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('linked campaign whose push never ran is NOT applied (unconfigured client / no base)', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', platform_campaign_id: 'g-1' }];
  mockSetMode.mockRejectedValue(Object.assign(new Error('"Pest Bradenton" is linked to a live Google Ads campaign, but the live push can\'t run — nothing was changed.'), { code: 'live_push_unavailable' }));

  const res = await apply({ action: 'change_mode', campaignName: 'Pest Bradenton', value: 'stop' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/can't run/);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('a mode the campaign is already in is a no-op → 422, manager never called', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', budget_mode: 'stop' }];

  const res = await apply({ action: 'change_mode', campaignName: 'Pest Bradenton', value: 'stop' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/already in stop mode/);
  expect(mockSetMode).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('campaign id resolving to a different name than the card shows → 422', async () => {
  mockCampaignById = { id: UUID_A, campaign_name: 'Lawn Venice', platform: 'google_ads', status: 'active' };

  const res = await apply({ action: 'increase_budget', campaignId: UUID_A, campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/mislabeled/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('AI budget more than 3× from the base is refused', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 3000 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/3× move/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('a sane budget within 3× of the base still applies', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: false, livePushAttempted: false });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
  expect(mockSetBudget).toHaveBeenCalledWith('c-1', 30, expect.any(String), { requireLivePush: true, requireBaseMode: true, requireActive: true, requireBoundFactor: 3, trigger: 'advisor' });
});

test('budget bound falls back to the current daily budget when no base exists', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: null, daily_budget_current: 10 }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 3000 });

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/3× move/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('no recorded budget at all → manual-only, nothing to bound against', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: null, daily_budget_current: null }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/no recorded daily budget/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('budget apply on a throttled (spent/stop) campaign is refused — the target would not go live', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20, budget_mode: 'spent' }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/throttled in "spent" mode/);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('paused campaign → 422, manager never called', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'paused', daily_budget_base: 20 }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/paused/);
  expect(mockSetBudget).not.toHaveBeenCalled();
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('budget already at the target (base AND current) → no-op 422', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 30, daily_budget_current: 30 }];

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.error).toMatch(/already at \$30\/day/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('same-base apply with drifted current is allowed (reconciles live budget)', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 30, daily_budget_current: 18 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(200);
  expect(res.body.applied).toBe(true);
});

test('concurrent mode change surfaces as 409, not a false applied', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20, budget_mode: 'base' }];
  mockSetBudget.mockRejectedValue(Object.assign(new Error('"Pest Bradenton" switched to "spent" mode — the new daily budget wouldn\'t take effect, so nothing was changed.'), { code: 'mode_conflict' }));

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });

  expect(res.status).toBe(409);
  expect(res.body.applied).toBe(false);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('persist-failure-after-push outcomes (rolled back / ambiguous) surface as 502 not applied', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
  mockSetBudget.mockRejectedValueOnce(Object.assign(new Error('rolled back'), { code: 'live_push_rolled_back' }));

  let res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });
  expect(res.status).toBe(502);
  expect(res.body.applied).toBe(false);

  mockSetBudget.mockRejectedValueOnce(Object.assign(new Error('ambiguous'), { code: 'live_push_ambiguous' }));
  res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });
  expect(res.status).toBe(502);
  expect(res.body.applied).toBe(false);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('applied_count increment failure does not flip a completed apply to an error', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
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
    { id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active' },
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
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active' }];
  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton' });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('change_mode with an invalid mode → 422 applied:false', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active' }];
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

test('a budget/mode apply with no campaign name → 422 (admin must see the target)', async () => {
  mockCampaignById = { id: UUID_A, campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 };

  const res = await apply({ action: 'increase_budget', campaignId: UUID_A, value: 30 });

  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);
  expect(res.body.error).toMatch(/no campaign name/);
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('an oversized model reason is truncated to the varchar(255) audit column', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20 }];
  mockSetBudget.mockResolvedValue({ campaign: 'Pest Bradenton', newBudget: 30, googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30, reason: 'x'.repeat(600) });

  expect(res.status).toBe(200);
  const sentReason = mockSetBudget.mock.calls[0][2];
  expect(sentReason.length).toBeLessThanOrEqual(255);
});

test('change_mode also sends the truncated reason', async () => {
  mockNameMatches = [{ id: 'c-9', campaign_name: 'Lawn Sarasota', platform: 'google_ads', status: 'active' }];
  mockSetMode.mockResolvedValue({ campaign: 'Lawn Sarasota', newMode: 'stop', googleAdsUpdated: true, livePushAttempted: true });

  const res = await apply({ action: 'change_mode', campaignName: 'Lawn Sarasota', value: 'stop', reason: 'y'.repeat(600) });

  expect(res.status).toBe(200);
  expect(mockSetMode.mock.calls[0][2].length).toBeLessThanOrEqual(255);
});

test('manager-thrown in-lock rechecks (budget_noop / budget_out_of_bounds) map to 422', async () => {
  mockNameMatches = [{ id: 'c-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active', daily_budget_base: 20, daily_budget_current: 18 }];
  mockSetBudget.mockRejectedValueOnce(Object.assign(new Error('already at $30/day'), { code: 'budget_noop' }));

  let res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });
  expect(res.status).toBe(422);
  expect(res.body.applied).toBe(false);

  mockSetBudget.mockRejectedValueOnce(Object.assign(new Error('more than a 3\u00d7 move'), { code: 'budget_out_of_bounds' }));
  res = await apply({ action: 'increase_budget', campaignName: 'Pest Bradenton', value: 30 });
  expect(res.status).toBe(422);
  expect(mockIncrement).not.toHaveBeenCalled();
});

describe('rule-based fallback recommendations are executable', () => {
  const advisor = require('../services/ads/campaign-advisor');

  const summary = (over = {}) => ({
    id: 'c-1', name: 'Pest Bradenton', platform: 'google_ads', status: 'active',
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

  test('fallback recs for a paused campaign stay advisory (apply would 422)', () => {
    const advice = advisor.generateFallbackAdvice(
      [summary({ status: 'paused' })], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined();
  });

  test('increase_budget fallback on a throttled (spent/stop) campaign stays advisory', () => {
    // The route rejects budget applies outside base mode — the fallback must
    // not render an Apply button that is guaranteed to 422.
    const advice = advisor.generateFallbackAdvice(
      [summary({ budgetMode: 'spent' })], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined();
    expect(rec.apply_value).toBeUndefined();
  });

  test('STOP fallback for a campaign already in stop mode stays advisory (no-op apply)', () => {
    const advice = advisor.generateFallbackAdvice(
      [summary({ budgetMode: 'stop', last7d: { roas: 1, lostISBudget: 0 } })], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined();
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

describe('normalizeRecommendations — model output passes the apply guards', () => {
  const advisor = require('../services/ads/campaign-advisor');

  const google = (over = {}) => ({
    id: 'g-uuid-1', campaign_name: 'Pest Bradenton', platform: 'google_ads',
    status: 'active', budget_mode: 'base', daily_budget_base: 20, daily_budget_current: 20,
    ...over,
  });

  const norm = (rec, campaigns) => advisor.normalizeRecommendations(
    { recommendations: [rec] }, campaigns).recommendations[0];

  test('a valid budget rec keeps its apply fields and gets the stable campaign_id', () => {
    const rec = norm(
      { campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 },
      [google()],
    );
    expect(rec.apply_action).toBe('increase_budget');
    expect(rec.campaign_id).toBe('g-uuid-1');
  });

  test('paused / throttled / no-op / out-of-bound / unknown-campaign recs are stripped to advisory', () => {
    const cases = [
      [{ campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 }, [google({ status: 'paused' })]],
      [{ campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 }, [google({ budget_mode: 'spent' })]],
      [{ campaign: 'Pest Bradenton', apply_action: 'change_mode', apply_value: 'base' }, [google()]], // already base
      [{ campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 3000 }, [google()]], // > 3x
      [{ campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 20 }, [google()]], // no-op: == base == current
      [{ campaign: 'Ghost', apply_action: 'increase_budget', apply_value: 30 }, [google()]],
      [{ campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 }, [google({ platform: 'facebook' })]],
    ];
    for (const [rec, campaigns] of cases) {
      const out = norm({ ...rec }, campaigns);
      expect(out.apply_action).toBeUndefined();
      expect(out.apply_value).toBeUndefined();
    }
  });

  test('an id pointing at a different campaign than the displayed name is stripped', () => {
    const rec = norm(
      { campaign: 'Pest Bradenton', campaign_id: 'g-uuid-2', apply_action: 'increase_budget', apply_value: 30 },
      [google(), google({ id: 'g-uuid-2', campaign_name: 'Lawn Venice' })],
    );
    expect(rec.apply_action).toBeUndefined();
  });

  test('an ambiguous bare name (two rows) is stripped', () => {
    const rec = norm(
      { campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 },
      [google(), google({ id: 'g-uuid-2', platform: 'facebook' })],
    );
    expect(rec.apply_action).toBeUndefined();
  });

  test('advisory recs pass through untouched', () => {
    const rec = norm({ campaign: 'page/query', apply_action: 'update_meta' }, [google()]);
    expect(rec.apply_action).toBe('update_meta');
  });
});

describe('normalizeRecommendations r7 — name required, linkage-aware', () => {
  const advisor = require('../services/ads/campaign-advisor');
  const google = (over = {}) => ({
    id: 'g-uuid-1', campaign_name: 'Pest Bradenton', platform: 'google_ads',
    status: 'active', budget_mode: 'base', daily_budget_base: 20, daily_budget_current: 20,
    ...over,
  });
  const norm = (rec, campaigns) => advisor.normalizeRecommendations(
    { recommendations: [rec] }, campaigns).recommendations[0];

  test('an id-only rec with no displayed campaign name is stripped', () => {
    const rec = norm({ campaign_id: 'g-uuid-1', apply_action: 'increase_budget', apply_value: 30 }, [google()]);
    expect(rec.apply_action).toBeUndefined();
  });

  test('change_mode on a linked campaign with no base budget is stripped (push would be unavailable)', () => {
    const rec = norm(
      { campaign: 'Pest Bradenton', apply_action: 'change_mode', apply_value: 'stop' },
      [google({ platform_campaign_id: 'g-123', daily_budget_base: null, budget_mode: 'base' })],
    );
    expect(rec.apply_action).toBeUndefined();
  });

  test('STOP fallback for a linked campaign with no base stays advisory', () => {
    const advice = advisor.generateFallbackAdvice([{
      id: 'c-1', name: 'Pest Bradenton', platform: 'google_ads', status: 'active',
      linked: true, dailyBudgetBase: null, dailyBudgetCurrent: 40,
      last7d: { roas: 1, lostISBudget: 0 }, last30d: {}, trending: 'flat',
    }], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined();
  });
});

describe('normalize/fallback r9 — client availability and tiny-budget bound', () => {
  const advisor = require('../services/ads/campaign-advisor');

  afterEach(() => { mockAdsConfigured.mockReturnValue(true); });

  test('a linked rec is stripped when the Google Ads client is unconfigured', () => {
    mockAdsConfigured.mockReturnValue(false);
    const rec = advisor.normalizeRecommendations({ recommendations: [
      { campaign: 'Pest Bradenton', apply_action: 'increase_budget', apply_value: 30 },
    ] }, [{
      id: 'g-1', campaign_name: 'Pest Bradenton', platform: 'google_ads', status: 'active',
      platform_campaign_id: '123', budget_mode: 'base', daily_budget_base: 20, daily_budget_current: 20,
    }]).recommendations[0];
    expect(rec.apply_action).toBeUndefined();
  });

  test('fallback recs for a linked campaign stay advisory when the client is unconfigured', () => {
    mockAdsConfigured.mockReturnValue(false);
    const advice = advisor.generateFallbackAdvice([{
      id: 'c-1', name: 'Pest Bradenton', platform: 'google_ads', status: 'active',
      linked: true, dailyBudgetBase: 20, dailyBudgetCurrent: 20,
      last7d: { roas: 6, lostISBudget: 30 }, last30d: {}, trending: 'flat',
    }], { min_roas: 4 });
    expect(advice.recommendations[0].apply_action).toBeUndefined();
  });

  test('tiny-budget fallback whose whole-dollar minimum exceeds the 3x bound stays advisory', () => {
    const advice = advisor.generateFallbackAdvice([{
      id: 'c-1', name: 'Pest Bradenton', platform: 'google_ads', status: 'active',
      linked: false, dailyBudgetBase: 0.3, dailyBudgetCurrent: 0.3,
      last7d: { roas: 6, lostISBudget: 30 }, last30d: {}, trending: 'flat',
    }], { min_roas: 4 });
    const rec = advice.recommendations[0];
    expect(rec).toBeDefined();
    expect(rec.apply_action).toBeUndefined(); // $1 target would be > 3x $0.30
  });
});
