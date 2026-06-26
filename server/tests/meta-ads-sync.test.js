// Tests services/ads/meta-ads.js — Meta Marketing API ingestion into the shared
// ad_campaigns / ad_performance_daily tables (platform='facebook').

let firstByTable = {};
const insertCalls = [];
const updateCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.update = jest.fn((row) => { updateCalls.push({ table, row }); return Promise.resolve(1); });
  b.insert = jest.fn((row) => {
    insertCalls.push({ table, row });
    return {
      returning: jest.fn(() => Promise.resolve([{ id: 'uuid-1', ...row }])),
      then: (res, rej) => Promise.resolve([1]).then(res, rej), // awaited inserts (perf)
    };
  });
  return b;
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_n, fn) => fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }), { virtual: true });

const MetaAds = require('../services/ads/meta-ads');
const { mapStatus, mapCampaign, mapInsightRow, sumActions, accountId } = MetaAds._private;

const env = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  firstByTable = {};
  insertCalls.length = 0;
  updateCalls.length = 0;
  process.env = { ...env, META_ADS_ACCESS_TOKEN: 'tok', META_ADS_ACCOUNT_ID: '1234567890' };
});
afterAll(() => { process.env = env; });

describe('pure mappers', () => {
  test('accountId normalizes to act_<digits>', () => {
    expect(accountId()).toBe('act_1234567890');
    process.env.META_ADS_ACCOUNT_ID = 'act_999';
    expect(accountId()).toBe('act_999');
    delete process.env.META_ADS_ACCOUNT_ID;
    expect(accountId()).toBeNull();
  });

  test('mapStatus maps Meta statuses', () => {
    expect(mapStatus('ACTIVE')).toBe('active');
    expect(mapStatus('PAUSED')).toBe('paused');
    expect(mapStatus('ARCHIVED')).toBe('removed');
    expect(mapStatus('DELETED')).toBe('removed');
    expect(mapStatus('WHATEVER')).toBe('unknown');
  });

  test('mapCampaign converts cents budget + tags platform=facebook', () => {
    const c = mapCampaign({ id: 'c1', name: 'Lead Gen', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: '5000' });
    expect(c).toMatchObject({
      platform: 'facebook',
      platform_campaign_id: 'c1',
      campaign_name: 'Lead Gen',
      status: 'active',
      campaign_type: 'OUTCOME_LEADS',
      daily_budget_base: 50, // 5000 cents -> $50
      daily_budget_current: 50,
    });
  });

  test('sumActions counts lead/purchase action types only', () => {
    const actions = [
      { action_type: 'lead', value: '2' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' },
      { action_type: 'landing_page_view', value: '99' },
    ];
    expect(sumActions(actions)).toBe(5);
    expect(sumActions(undefined)).toBe(0);
  });

  test('mapInsightRow maps spend/ctr/cpc + derives roas', () => {
    const r = mapInsightRow({
      date_start: '2026-06-26', impressions: '1000', clicks: '50', spend: '25.50',
      ctr: '5', cpc: '0.51',
      actions: [{ action_type: 'lead', value: '3' }],
      action_values: [{ action_type: 'lead', value: '300' }],
    });
    expect(r).toMatchObject({
      date: '2026-06-26', impressions: 1000, clicks: 50, cost: 25.5,
      conversions: 3, conversion_value: 300, ctr: 5, avg_cpc: 0.51,
    });
    expect(r.roas).toBeCloseTo(11.76, 1); // 300/25.5
  });
});

describe('isConfigured', () => {
  test('requires token + account id', () => {
    expect(MetaAds.isConfigured()).toBe(true);
    delete process.env.META_ADS_ACCESS_TOKEN;
    expect(MetaAds.isConfigured()).toBe(false);
  });
});

describe('syncCampaigns', () => {
  test('inserts a facebook campaign from the Graph API', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'c1', name: 'Lead Gen', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: '5000' }], paging: {} }),
    });
    firstByTable.ad_campaigns = undefined; // no existing

    const results = await MetaAds.syncCampaigns();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('/act_1234567890/campaigns');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe('ad_campaigns');
    expect(insertCalls[0].row).toMatchObject({ platform: 'facebook', platform_campaign_id: 'c1', status: 'active', daily_budget_base: 50 });
    expect(results).toHaveLength(1);
  });

  test('returns [] when not configured (never throws)', async () => {
    delete process.env.META_ADS_ACCESS_TOKEN;
    global.fetch = jest.fn();
    const results = await MetaAds.syncCampaigns();
    expect(results).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('syncDailyPerformance', () => {
  test('upserts insight rows for known campaigns only', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ campaign_id: 'c1', date_start: '2026-06-26', impressions: '1000', clicks: '50', spend: '25.50', ctr: '5', cpc: '0.51', actions: [{ action_type: 'lead', value: '3' }] }],
        paging: {},
      }),
    });
    firstByTable.ad_campaigns = { id: 'local-c1' }; // campaign resolves
    firstByTable.ad_performance_daily = undefined;  // no existing perf row

    const results = await MetaAds.syncDailyPerformance(7);

    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('/act_1234567890/insights');
    expect(url).toContain('time_increment');
    const perfInsert = insertCalls.find((c) => c.table === 'ad_performance_daily');
    expect(perfInsert.row).toMatchObject({ campaign_id: 'local-c1', date: '2026-06-26', cost: 25.5, conversions: 3 });
    expect(results).toHaveLength(1);
  });

  test('surfaces a Graph API error as [] (caught, not thrown)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token' } }) });
    const results = await MetaAds.syncDailyPerformance(7);
    expect(results).toEqual([]);
  });
});
