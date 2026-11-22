// Tests services/ads/google-lsa.js: the read-only Local Services Ads sync into
// the shared ad_campaigns / ad_performance_daily tables (platform='google_lsa').
// Behavior: the account signs in as itself, a day's conversions are its CHARGED
// leads, a lead-only day still gets a row, and a failed step fails the run.
// Regression guarded: Local Services cost never reaching the Ads page, or a
// failed sync reading as a success.

let firstByTable = {};
let lsaCampaignRows = [];
const insertCalls = [];
const updateCalls = [];
const whereNotInCalls = [];
const whereNotNullCalls = [];
const whereArgs = [];

const mockDb = jest.fn((table) => {
  const b = {};
  b.where = jest.fn((...args) => { whereArgs.push({ table, args }); return b; });
  b.whereNot = jest.fn(() => b);
  b.whereNotNull = jest.fn((col) => { whereNotNullCalls.push({ table, col }); return b; });
  b.whereNotIn = jest.fn((col, ids) => { whereNotInCalls.push({ table, col, ids }); return b; });
  b.select = jest.fn(() => Promise.resolve(lsaCampaignRows));
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.update = jest.fn((row) => { updateCalls.push({ table, row }); return Promise.resolve(row.status === 'removed' ? 0 : 1); });
  b.insert = jest.fn((row) => {
    insertCalls.push({ table, row });
    return {
      returning: jest.fn(() => Promise.resolve([{ ...row }])),
      then: (res, rej) => Promise.resolve([1]).then(res, rej), // awaited inserts (performance rows)
    };
  });
  return b;
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }));
const mockQuery = jest.fn();
const mockCustomerFactory = jest.fn(() => ({ query: (...a) => mockQuery(...a) }));
jest.mock('google-ads-api', () => ({
  GoogleAdsApi: jest.fn(() => ({ Customer: (...a) => mockCustomerFactory(...a) })),
}));

const logger = require('../services/logger');
const GoogleLsa = require('../services/ads/google-lsa');
const { customerId, mapStatus, mapCampaign, mapPerformanceRow, tallyLeadsByDay, dateRange } = GoogleLsa._private;

const GOOGLE_ENV = {
  GOOGLE_ADS_CLIENT_ID: 'cid',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
  GOOGLE_ADS_CUSTOMER_ID: '1112223333',
};
const CAMPAIGN_ROW = {
  campaign: { id: 555, name: 'LocalServicesCampaign:SystemGenerated:0abc', status: 2 },
  campaign_budget: { amount_micros: 25500000 },
};
const lead = (createdAt, type, charged) => ({
  local_services_lead: { id: 1, lead_type: type, creation_date_time: createdAt, lead_charged: charged },
});

// Answers each GAQL query by the resource it reads.
function answerGoogle({ campaigns = [CAMPAIGN_ROW], metrics = [], leads = [] } = {}) {
  mockQuery.mockImplementation(async (gaql) => {
    if (/FROM local_services_lead/.test(gaql)) return leads;
    if (/segments\.date/.test(gaql)) return metrics;
    return campaigns;
  });
}

const env = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  firstByTable = {};
  lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555' }];
  insertCalls.length = 0;
  updateCalls.length = 0;
  whereNotInCalls.length = 0;
  whereNotNullCalls.length = 0;
  whereArgs.length = 0;
  process.env = { ...env, ...GOOGLE_ENV };
  delete process.env.GOOGLE_LSA_CUSTOMER_ID;
  answerGoogle();
});
afterAll(() => { process.env = env; });

describe('configuration', () => {
  test('uses the Waves Local Services account unless the env names another', () => {
    expect(customerId()).toBe('7636809139');
    process.env.GOOGLE_LSA_CUSTOMER_ID = '123-456-7890';
    expect(customerId()).toBe('1234567890');
  });

  test('a value that is not an account id turns the sync off', () => {
    process.env.GOOGLE_LSA_CUSTOMER_ID = 'off';
    expect(customerId()).toBeNull();
    expect(GoogleLsa.isConfigured()).toBe(false);
  });

  test('needs the Google Ads credentials', () => {
    expect(GoogleLsa.isConfigured()).toBe(true);
    delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
    expect(GoogleLsa.isConfigured()).toBe(false);
  });

  test('not configured: the run reads nothing and writes nothing', async () => {
    process.env.GOOGLE_LSA_CUSTOMER_ID = 'off';
    await expect(GoogleLsa.runDailySync()).resolves.toEqual({ configured: false, synced: {} });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('signs in as the Local Services account itself, not under the Search manager', async () => {
    process.env.GOOGLE_LSA_CUSTOMER_ID = '2223334444';
    await GoogleLsa.runDailySync();
    expect(mockCustomerFactory).toHaveBeenCalledWith({
      customer_id: '2223334444',
      login_customer_id: '2223334444',
      refresh_token: 'refresh',
    });
  });
});

describe('pure mappers', () => {
  test('mapStatus takes the SDK number or the name', () => {
    expect(mapStatus(2)).toBe('active');
    expect(mapStatus('PAUSED')).toBe('paused');
    expect(mapStatus(4)).toBe('removed');
    expect(mapStatus(0)).toBe('unknown');
  });

  test('mapCampaign tags the row google_lsa, mirrors the daily budget and names a system campaign', () => {
    expect(mapCampaign(CAMPAIGN_ROW)).toMatchObject({
      platform: 'google_lsa',
      platform_campaign_id: '555',
      campaign_name: 'Local Service Ads',
      status: 'active',
      campaign_type: 'google_lsa',
      daily_budget_base: 25.5,
      daily_budget_current: 25.5,
    });
  });

  test('mapCampaign keeps a name a person gave the campaign, and a missing budget is null', () => {
    const c = mapCampaign({ campaign: { id: 9, name: 'Pest - Bradenton', status: 3 } });
    expect(c).toMatchObject({ campaign_name: 'Pest - Bradenton', status: 'paused', daily_budget_base: null, daily_budget_current: null });
  });

  test('tallyLeadsByDay counts each day by type and by charge', () => {
    const byDay = tallyLeadsByDay([
      lead('2026-11-20 09:15:00', 3, true),
      lead('2026-11-20 18:40:00', 'MESSAGE', false),
      lead('2026-11-21 08:00:00', 4, true),
      lead('', 3, true), // no readable date: left out
    ]);
    expect(Object.fromEntries(byDay)).toEqual({
      '2026-11-20': { total: 2, charged: 1, calls: 1, messages: 1, bookings: 0 },
      '2026-11-21': { total: 1, charged: 1, calls: 0, messages: 0, bookings: 1 },
    });
  });

  test('mapPerformanceRow: conversions = charged leads, Google\'s own number kept beside it', () => {
    const row = mapPerformanceRow(
      { impressions: 40, clicks: 4, cost_micros: 62000000, conversions: 3, conversions_value: 0, ctr: 0.1, average_cpc: 15500000 },
      { total: 3, charged: 2, calls: 2, messages: 1, bookings: 0 },
    );
    expect(row).toMatchObject({ impressions: 40, clicks: 4, cost: 62, conversions: 2, ctr: 10, avg_cpc: 15.5, roas: 0 });
    expect(JSON.parse(row.metadata)).toEqual({
      google_conversions: 3,
      lsa_leads: { total: 3, charged: 2, calls: 2, messages: 1, bookings: 0 },
    });
  });

  test('mapPerformanceRow with no lead tally keeps Google\'s conversions', () => {
    const row = mapPerformanceRow({ cost_micros: 31000000, conversions: 1 }, null);
    expect(row).toMatchObject({ cost: 31, conversions: 1 });
    expect(JSON.parse(row.metadata)).toEqual({ google_conversions: 1 });
  });

  test('dateRange is a window of Eastern calendar days', () => {
    expect(dateRange(30, new Date('2026-11-22T03:30:00Z'))).toEqual({ since: '2026-10-22', until: '2026-11-21' });
  });
});

describe('runDailySync', () => {
  const perfInserts = () => insertCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);

  test('a new campaign is inserted as a google_lsa row', async () => {
    const out = await GoogleLsa.runDailySync();
    const inserted = insertCalls.find((c) => c.table === 'ad_campaigns');
    expect(inserted.row).toMatchObject({
      platform: 'google_lsa', platform_campaign_id: '555', campaign_type: 'google_lsa', status: 'active', daily_budget_current: 25.5,
    });
    expect(out).toEqual({ configured: true, synced: { campaigns: 1, performanceRows: 0 } });
  });

  test('a campaign that already exists is updated in place', async () => {
    firstByTable.ad_campaigns = { id: 'local-1', platform: 'google_lsa', platform_campaign_id: '555', status: 'paused' };
    await GoogleLsa.runDailySync();
    expect(insertCalls.filter((c) => c.table === 'ad_campaigns')).toEqual([]);
    expect(updateCalls.find((c) => c.table === 'ad_campaigns' && c.row.status === 'active')).toBeTruthy();
  });

  test('the removed pass covers only synced rows that Google no longer returns', async () => {
    await GoogleLsa.runDailySync();
    expect(whereNotInCalls).toEqual([{ table: 'ad_campaigns', col: 'platform_campaign_id', ids: ['555'] }]);
    // A campaign entered by hand has no Google id: the pass must skip it.
    expect(whereNotNullCalls).toContainEqual({ table: 'ad_campaigns', col: 'platform_campaign_id' });
    const fence = whereArgs.find((w) => w.table === 'ad_campaigns' && w.args[0] === 'updated_at');
    expect(fence.args[1]).toBe('<');
    expect(fence.args[2]).toBeInstanceOf(Date);
  });

  test('a day\'s cost and charged leads land on one row; a lead-only day still gets a row', async () => {
    answerGoogle({
      metrics: [{
        campaign: { id: 555 }, segments: { date: '2026-11-20' },
        metrics: { impressions: 30, clicks: 3, cost_micros: 62000000, conversions: 2, conversions_value: 0, ctr: 0.1, average_cpc: 20666667 },
      }],
      leads: [
        lead('2026-11-20 09:15:00', 3, true),
        lead('2026-11-20 18:40:00', 2, false),
        lead('2026-11-21 08:00:00', 3, true),
      ],
    });
    jest.useFakeTimers({ now: new Date('2026-11-21T15:00:00Z') });
    try {
      await GoogleLsa.runDailySync();
    } finally { jest.useRealTimers(); }

    const rows = perfInserts();
    expect(rows.map((r) => [r.campaign_id, r.date, r.cost, r.conversions])).toEqual([
      ['local-1', '2026-11-20', 62, 1],
      ['local-1', '2026-11-21', 0, 1],
    ]);
    expect(JSON.parse(rows[0].metadata).lsa_leads).toEqual({ total: 2, charged: 1, calls: 1, messages: 1, bookings: 0 });
  });

  test('a metrics day with no lead reads zero conversions, not Google\'s number', async () => {
    answerGoogle({
      metrics: [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { impressions: 12, cost_micros: 0, conversions: 1 } }],
    });
    await GoogleLsa.runDailySync();
    expect(perfInserts()[0]).toMatchObject({ conversions: 0 });
  });

  test('with two live campaigns a lead has no known campaign: leads are not counted and the log says so', async () => {
    lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555' }, { id: 'local-2', platform_campaign_id: '556' }];
    answerGoogle({
      metrics: [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000, conversions: 1 } }],
      leads: [lead('2026-11-20 09:15:00', 3, true), lead('2026-11-21 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    const rows = perfInserts();
    expect(rows).toHaveLength(1); // no lead-only row
    expect(rows[0]).toMatchObject({ campaign_id: 'local-1', conversions: 1 });
    expect(JSON.parse(rows[0].metadata)).toEqual({ google_conversions: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 lead(s) not counted'));
  });

  test('a metrics row for a campaign the portal does not hold is skipped', async () => {
    answerGoogle({ metrics: [{ campaign: { id: 999 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 5000000 } }] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
  });

  test('an existing day is updated, not inserted again', async () => {
    firstByTable.ad_performance_daily = { id: 'perf-1' };
    answerGoogle({ metrics: [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000 } }] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
    expect(updateCalls.find((c) => c.table === 'ad_performance_daily').row).toMatchObject({ date: '2026-11-20', cost: 31 });
  });

  test('a failed campaign step fails the run after the performance step ran', async () => {
    mockQuery.mockImplementation(async (gaql) => {
      if (/FROM local_services_lead/.test(gaql)) return [];
      if (/segments\.date/.test(gaql)) return [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000 } }];
      throw new Error('invalid_grant');
    });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('invalid_grant');
    expect(perfInserts()).toHaveLength(1);
  });

  test('a failed performance step fails the run', async () => {
    mockQuery.mockImplementation(async (gaql) => {
      if (/segments\.date/.test(gaql)) throw new Error('quota');
      return [CAMPAIGN_ROW];
    });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('quota');
  });
});
