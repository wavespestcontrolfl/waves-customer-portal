// Tests services/ads/google-lsa.js: the read-only Local Services Ads sync into
// the shared ad_campaigns / ad_performance_daily tables (platform='google_lsa').
// Behavior: the account signs in as itself, only Local Services campaigns are
// read, ONE portal row stands for the account (found by its mark, never
// 'removed'), a day's conversions are always its leads charged and not credited
// back, a lead-only day still gets a row, and a failed step fails the run.
// Regression guarded: Local Services cost never reaching the Ads page, history
// lost when Google replaces the campaign, or a failed sync reading as a success.

let accountRowInDb; // the row the mark lookup finds (undefined = first run)
let storedPerfRows = [];
const insertCalls = [];
const updateCalls = [];
const whereRawCalls = [];
const whereCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  b.where = jest.fn((...args) => { whereCalls.push({ table, args }); return b; });
  b.whereRaw = jest.fn((sql, bindings) => { whereRawCalls.push({ table, sql, bindings }); return b; });
  b.orderBy = jest.fn(() => b);
  b.select = jest.fn(() => Promise.resolve(storedPerfRows));
  b.first = jest.fn(() => Promise.resolve(accountRowInDb));
  b.update = jest.fn((row) => { updateCalls.push({ table, row }); return Promise.resolve(1); });
  b.insert = jest.fn((row) => {
    insertCalls.push({ table, row });
    return {
      returning: jest.fn(() => Promise.resolve([{ ...row }])),
      then: (res, rej) => Promise.resolve([1]).then(res, rej), // awaited inserts (performance rows)
    };
  });
  return b;
});
mockDb.raw = jest.fn((sql, bindings) => ({ rawSql: sql, bindings }));
// The performance rows are written inside one transaction; the mock runs the body on the same recorder.
mockDb.transaction = jest.fn(async (body) => body(mockDb));

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
const { customerId, accountState, sumMetricsByDay, mapPerformanceRow, tallyLeadsByDay, dateRange } = GoogleLsa._private;
const NO_LEADS = { total: 0, charged: 0, credited: 0, calls: 0, messages: 0, bookings: 0 };
const NO_METRICS = { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionValue: 0 };
const ACCOUNT = '7636809139';
const ACCOUNT_ROW = { id: 'local-1', platform: 'google_lsa', platform_campaign_id: ACCOUNT, campaign_name: 'Local Service Ads', status: 'active' };

const GOOGLE_ENV = {
  GOOGLE_ADS_CLIENT_ID: 'cid',
  GOOGLE_ADS_CLIENT_SECRET: 'secret',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh',
  GOOGLE_ADS_CUSTOMER_ID: '1112223333',
};
const googleCampaign = (id, status, micros) => ({ campaign: { id, status }, campaign_budget: micros == null ? {} : { amount_micros: micros } });
const CAMPAIGN_ROW = googleCampaign(555, 2, 25500000);
const metricsRow = (date, metrics, id = 555) => ({ campaign: { id }, segments: { date }, metrics });
const lead = (createdAt, type, charged, creditState) => ({
  local_services_lead: {
    id: 1, lead_type: type, creation_date_time: createdAt, lead_charged: charged,
    ...(creditState ? { credit_details: { credit_state: creditState } } : {}),
  },
});

// Answers each GAQL query by the resource it reads. `creditChanges` = the leads
// whose credit Google changed inside the window (the window-start query).
function answerGoogle({ campaigns = [CAMPAIGN_ROW], metrics = [], leads = [], creditChanges = [] } = {}) {
  mockQuery.mockImplementation(async (gaql) => {
    if (/credit_state_last_update_date_time/.test(gaql)) return creditChanges;
    if (/FROM local_services_lead/.test(gaql)) return leads;
    if (/segments\.date/.test(gaql)) return metrics;
    return campaigns;
  });
}

const env = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  accountRowInDb = { ...ACCOUNT_ROW };
  storedPerfRows = [];
  insertCalls.length = 0;
  updateCalls.length = 0;
  whereRawCalls.length = 0;
  whereCalls.length = 0;
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
    // The whole value must be an id: digits inside other text never switch it on.
    for (const bad of ['off-1234567890', 'x1234567890', '12345678901', '123-456-789', '']) {
      process.env.GOOGLE_LSA_CUSTOMER_ID = bad;
      expect(customerId()).toBeNull();
    }
  });

  test('needs the Google Ads OAuth credentials, not the Search account id', () => {
    delete process.env.GOOGLE_ADS_CUSTOMER_ID;
    expect(GoogleLsa.isConfigured()).toBe(true);
    delete process.env.GOOGLE_ADS_REFRESH_TOKEN;
    expect(GoogleLsa.isConfigured()).toBe(false);
  });

  test('ownsCampaign: only a google_lsa row marked with the account the sync reads now', () => {
    const row = (over) => ({ platform: 'google_lsa', platform_campaign_id: '555', metadata: { lsa_customer_id: '7636809139' }, ...over });
    expect(GoogleLsa.ownsCampaign(row())).toBe(true);
    expect(GoogleLsa.ownsCampaign(row({ metadata: JSON.stringify({ lsa_customer_id: '7636809139' }) }))).toBe(true);
    expect(GoogleLsa.ownsCampaign(row({ metadata: null }))).toBe(false); // entered by hand
    expect(GoogleLsa.ownsCampaign(row({ metadata: { lsa_customer_id: '1112223333' } }))).toBe(false); // another account
    expect(GoogleLsa.ownsCampaign(row({ platform: 'google_ads' }))).toBe(false);
    process.env.GOOGLE_LSA_CUSTOMER_ID = 'off';
    expect(GoogleLsa.ownsCampaign(row())).toBe(false);
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
  test('accountState: active while Google has a campaign enabled, with what the enabled ones can spend', () => {
    expect(accountState([CAMPAIGN_ROW])).toEqual({ status: 'active', daily_budget_base: 25.5, daily_budget_current: 25.5 });
    // A paused campaign beside it does not add to what the account can spend.
    expect(accountState([CAMPAIGN_ROW, googleCampaign(556, 3, 10000000)])).toMatchObject({ status: 'active', daily_budget_current: 25.5 });
    expect(accountState([googleCampaign(555, 'ENABLED', 5000000), googleCampaign(556, 'ENABLED', 7000000)]))
      .toMatchObject({ status: 'active', daily_budget_current: 12 });
  });

  test('accountState: never removed. No enabled campaign = paused, with what the paused ones would spend', () => {
    expect(accountState([googleCampaign(555, 3, 10000000)])).toEqual({ status: 'paused', daily_budget_base: 10, daily_budget_current: 10 });
    expect(accountState([googleCampaign(555, 4, 10000000)])).toEqual({ status: 'paused', daily_budget_base: null, daily_budget_current: null });
    expect(accountState([googleCampaign(555, 'REMOVED', 10000000), googleCampaign(556, 'PAUSED')]))
      .toEqual({ status: 'paused', daily_budget_base: null, daily_budget_current: null });
    expect(accountState([])).toEqual({ status: 'paused', daily_budget_base: null, daily_budget_current: null });
  });

  test('sumMetricsByDay adds the campaigns of one day and keeps the days apart', () => {
    const byDay = sumMetricsByDay([
      metricsRow('2026-11-20', { impressions: 40, clicks: 3, cost_micros: 31000000, conversions: 0.5, conversions_value: 10 }),
      metricsRow('2026-11-20', { impressions: 10, clicks: 1, cost_micros: 5000000, conversions: 0.5, conversions_value: 0 }, 556),
      metricsRow('2026-11-21', { cost_micros: 1000000 }),
    ]);
    expect(byDay.get('2026-11-20')).toEqual({ impressions: 50, clicks: 4, costMicros: 36000000, conversions: 1, conversionValue: 10 });
    expect(byDay.get('2026-11-21')).toEqual({ ...NO_METRICS, costMicros: 1000000 });
  });

  test('tallyLeadsByDay counts each day by type and by charge', () => {
    const byDay = tallyLeadsByDay([
      lead('2026-11-20 09:15:00', 3, true),
      lead('2026-11-20 13:40:10', 2, true),
      lead('2026-11-20 18:02:00', 3, false),
      lead('2026-11-21 08:00:00', 'BOOKING', true),
      lead('', 3, true), // no date: left out
    ]);
    expect(byDay.get('2026-11-20')).toEqual({ total: 3, charged: 2, credited: 0, calls: 2, messages: 1, bookings: 0 });
    expect(byDay.get('2026-11-21')).toEqual({ total: 1, charged: 1, credited: 0, calls: 0, messages: 0, bookings: 1 });
    expect(byDay.size).toBe(2);
  });

  test('a lead Google credited back is not a charged lead; a pending credit still is', () => {
    const byDay = tallyLeadsByDay([
      lead('2026-11-20 09:15:00', 3, true, 3), // CREDITED
      lead('2026-11-20 10:15:00', 3, true, 'CREDITED'),
      lead('2026-11-20 11:15:00', 3, true, 2), // PENDING: still charged
    ]);
    expect(byDay.get('2026-11-20')).toEqual({ total: 3, charged: 1, credited: 2, calls: 3, messages: 0, bookings: 0 });
  });

  test('mapPerformanceRow: conversions = charged leads, Google\'s own number kept beside it', () => {
    const leads = { total: 3, charged: 2, credited: 0, calls: 2, messages: 1, bookings: 0 };
    const row = mapPerformanceRow({ impressions: 50, clicks: 4, costMicros: 76000000, conversions: 1, conversionValue: 38 }, leads);
    expect(row).toMatchObject({ impressions: 50, clicks: 4, cost: 76, conversions: 2, conversion_value: 38, ctr: 8, avg_cpc: 19, roas: 0.5 });
    expect(JSON.parse(row.metadata)).toEqual({ google_conversions: 1, lsa_leads: leads });
  });

  test('mapPerformanceRow on a day with no lead and no click: zero conversions, never Google\'s number, no division by zero', () => {
    const row = mapPerformanceRow({ ...NO_METRICS, costMicros: 31000000, conversions: 4 }, NO_LEADS);
    expect(row).toMatchObject({ cost: 31, conversions: 0, ctr: 0, avg_cpc: 0, roas: 0 });
    expect(JSON.parse(row.metadata).google_conversions).toBe(4);
  });

  test('dateRange is a window of Eastern calendar days', () => {
    expect(dateRange(30, new Date('2026-11-21T15:00:00Z'))).toEqual({ since: '2026-10-22', until: '2026-11-21' });
  });
});

describe('runDailySync', () => {
  const perfInserts = () => insertCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);
  const perfUpdates = () => updateCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);
  const accountUpdate = () => updateCalls.find((c) => c.table === 'ad_campaigns')?.row;
  const accountInsert = () => insertCalls.find((c) => c.table === 'ad_campaigns')?.row;

  test('every campaign query reads the Local Services channel only, with no status filter', async () => {
    await GoogleLsa.runDailySync();
    const campaignQueries = mockQuery.mock.calls.map((c) => c[0]).filter((q) => /FROM campaign/.test(q));
    expect(campaignQueries).toHaveLength(2); // the account step and the metrics
    for (const q of campaignQueries) {
      expect(q).toContain("campaign.advertising_channel_type = 'LOCAL_SERVICES'");
      expect(q).not.toMatch(/campaign\.status\s*(!=|=|IN)/);
    }
  });

  test('the first run inserts ONE google_lsa row for the account, marked with the account', async () => {
    accountRowInDb = undefined;
    await expect(GoogleLsa.runDailySync()).resolves.toEqual({ configured: true, synced: { campaigns: 1, performanceRows: 0 } });
    expect(insertCalls.filter((c) => c.table === 'ad_campaigns')).toHaveLength(1);
    expect(accountInsert()).toMatchObject({
      platform: 'google_lsa', campaign_type: 'google_lsa', platform_campaign_id: ACCOUNT,
      campaign_name: 'Local Service Ads', status: 'active', daily_budget_base: 25.5, daily_budget_current: 25.5,
    });
    expect(JSON.parse(accountInsert().metadata)).toEqual({ lsa_customer_id: ACCOUNT });
  });

  test('the row is found by the account mark, never by a Google id: a row entered by hand is never taken over', async () => {
    await GoogleLsa.runDailySync();
    expect(whereRawCalls).toEqual([{ table: 'ad_campaigns', sql: "metadata ->> 'lsa_customer_id' = ?", bindings: [ACCOUNT] }]);
    const campaignWheres = whereCalls.filter((c) => c.table === 'ad_campaigns').map((c) => c.args[0]);
    expect(campaignWheres).toEqual([{ platform: 'google_lsa' }, { id: 'local-1' }]); // the mark lookup, then the update by id
  });

  test('on a later run only what Google owns is refreshed: a name the office gave the row stays', async () => {
    accountRowInDb = { ...ACCOUNT_ROW, campaign_name: 'LSA Lakewood Ranch', status: 'paused' };
    await GoogleLsa.runDailySync();
    expect(accountInsert()).toBeUndefined();
    expect(Object.keys(accountUpdate()).sort()).toEqual(['daily_budget_base', 'daily_budget_current', 'status', 'updated_at']);
    expect(accountUpdate()).toMatchObject({ status: 'active', daily_budget_current: 25.5 });
  });

  test('Google replaced the campaign: the same row goes on, active, with the new campaign\'s budget and both campaigns\' days', async () => {
    answerGoogle({
      campaigns: [googleCampaign(555, 4, 25500000), googleCampaign(777, 2, 30000000)],
      metrics: [
        metricsRow('2026-11-19', { cost_micros: 38000000 }, 555), // the removed campaign's last day
        metricsRow('2026-11-20', { cost_micros: 17000000 }, 777),
      ],
    });
    await expect(GoogleLsa.runDailySync()).resolves.toEqual({ configured: true, synced: { campaigns: 2, performanceRows: 2 } });
    expect(accountInsert()).toBeUndefined();
    expect(accountUpdate()).toMatchObject({ status: 'active', daily_budget_current: 30 });
    expect(perfInserts().map((r) => [r.campaign_id, r.date, r.cost])).toEqual([['local-1', '2026-11-19', 38], ['local-1', '2026-11-20', 17]]);
  });

  test('Google removed the only campaign: the row reads paused, never removed, and still gets the campaign\'s last days', async () => {
    answerGoogle({
      campaigns: [googleCampaign(555, 4, 25500000)],
      metrics: [metricsRow('2026-11-19', { cost_micros: 38000000 })],
      leads: [lead('2026-11-19 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    expect(accountUpdate()).toMatchObject({ status: 'paused', daily_budget_current: null });
    expect(perfInserts()).toHaveLength(1);
    expect(perfInserts()[0]).toMatchObject({ campaign_id: 'local-1', date: '2026-11-19', cost: 38, conversions: 1 });
  });

  test('an account with no Local Services campaign and no row: nothing is written and the performance step does not run', async () => {
    accountRowInDb = undefined;
    answerGoogle({ campaigns: [] });
    await expect(GoogleLsa.runDailySync()).resolves.toEqual({ configured: true, synced: { campaigns: 0, performanceRows: 0 } });
    expect(insertCalls).toEqual([]);
    expect(updateCalls).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a day\'s cost and charged leads land on one row; a lead-only day still gets a row', async () => {
    answerGoogle({
      metrics: [metricsRow('2026-11-20', { impressions: 40, clicks: 3, cost_micros: 76000000, conversions: 1, conversions_value: 0 })],
      leads: [
        lead('2026-11-20 09:15:00', 3, true),
        lead('2026-11-20 13:40:10', 2, true),
        lead('2026-11-21 08:00:00', 3, false), // Google has no metrics row for this day
      ],
    });
    await expect(GoogleLsa.runDailySync()).resolves.toEqual({ configured: true, synced: { campaigns: 1, performanceRows: 2 } });
    const rows = perfInserts();
    expect(rows.map((r) => r.date)).toEqual(['2026-11-20', '2026-11-21']);
    expect(rows[0]).toMatchObject({ campaign_id: 'local-1', cost: 76, clicks: 3, conversions: 2 });
    expect(JSON.parse(rows[0].metadata)).toEqual({
      google_conversions: 1,
      lsa_leads: { total: 2, charged: 2, credited: 0, calls: 1, messages: 1, bookings: 0 },
    });
    expect(rows[1]).toMatchObject({ campaign_id: 'local-1', cost: 0, conversions: 0 });
    expect(JSON.parse(rows[1].metadata).lsa_leads).toEqual({ total: 1, charged: 0, credited: 0, calls: 1, messages: 0, bookings: 0 });
  });

  test('two Google campaigns on one day are one row: the cost is added and each lead is counted once', async () => {
    answerGoogle({
      campaigns: [CAMPAIGN_ROW, googleCampaign(777, 2, 30000000)],
      metrics: [
        metricsRow('2026-11-20', { clicks: 1, cost_micros: 31000000, conversions: 1 }, 555),
        metricsRow('2026-11-20', { clicks: 1, cost_micros: 5000000, conversions: 2 }, 777),
      ],
      leads: [lead('2026-11-20 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toHaveLength(1);
    expect(perfInserts()[0]).toMatchObject({ date: '2026-11-20', cost: 36, clicks: 2, conversions: 1 });
    expect(JSON.parse(perfInserts()[0].metadata).google_conversions).toBe(3);
  });

  test('a metrics day with no lead reads zero conversions, not Google\'s number', async () => {
    answerGoogle({ metrics: [metricsRow('2026-11-20', { cost_micros: 31000000, conversions: 4 })] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()[0]).toMatchObject({ cost: 31, conversions: 0 });
    expect(JSON.parse(perfInserts()[0].metadata)).toEqual({ google_conversions: 4, lsa_leads: NO_LEADS });
  });

  test('a stored day is updated, not inserted again, and reads only the account row\'s days', async () => {
    storedPerfRows = [{ id: 'perf-1', day: '2026-11-20' }];
    answerGoogle({ metrics: [metricsRow('2026-11-20', { cost_micros: 31000000 })] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
    expect(perfUpdates()).toHaveLength(1);
    expect(perfUpdates()[0]).toMatchObject({ campaign_id: 'local-1', date: '2026-11-20', cost: 31 });
    const perfWheres = whereCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.args);
    expect(perfWheres[0]).toEqual([{ campaign_id: 'local-1' }]);
    expect(perfWheres).toContainEqual([{ id: 'perf-1' }]);
  });

  test('a stored day Google no longer reports is written again as a zero day', async () => {
    storedPerfRows = [{ id: 'perf-1', day: '2026-11-19' }];
    await GoogleLsa.runDailySync();
    expect(perfUpdates()).toHaveLength(1);
    expect(perfUpdates()[0]).toMatchObject({ date: '2026-11-19', cost: 0, clicks: 0, conversions: 0 });
    expect(JSON.parse(perfUpdates()[0].metadata)).toEqual({ google_conversions: 0, lsa_leads: NO_LEADS });
  });

  test('the day rows are written in one transaction', async () => {
    storedPerfRows = [{ id: 'perf-1', day: '2026-11-19' }];
    answerGoogle({ metrics: [metricsRow('2026-11-20', { cost_micros: 31000000 })] });
    await GoogleLsa.runDailySync();
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(perfInserts()).toHaveLength(1); // 11-20
    expect(perfUpdates()).toHaveLength(1); // 11-19 reset
  });

  describe('the window', () => {
    beforeAll(() => { jest.useFakeTimers().setSystemTime(new Date('2026-11-21T15:00:00Z')); });
    afterAll(() => { jest.useRealTimers(); });
    const windowOf = () => {
      const metricsQuery = mockQuery.mock.calls.map((c) => c[0]).find((q) => /segments\.date BETWEEN/.test(q));
      const leadQuery = mockQuery.mock.calls.map((c) => c[0]).find((q) => /creation_date_time >=/.test(q) && !/credit_state_last_update/.test(q));
      return { metrics: metricsQuery.match(/BETWEEN '(\S+)' AND '(\S+)'/).slice(1), leads: leadQuery.match(/creation_date_time >= '(\S+) /)[1] };
    };

    test('30 Eastern days, the same for the cost and for the leads', async () => {
      await GoogleLsa.runDailySync();
      expect(windowOf()).toEqual({ metrics: ['2026-10-22', '2026-11-21'], leads: '2026-10-22' });
    });

    test('a late credit moves the start of the window back to the lead\'s own day', async () => {
      answerGoogle({ creditChanges: [lead('2026-10-05 10:00:00', 3, true, 3)] });
      await GoogleLsa.runDailySync();
      expect(windowOf()).toEqual({ metrics: ['2026-10-05', '2026-11-21'], leads: '2026-10-05' });
    });

    test('the window never starts before the 90 days the cost allocation recomputes', async () => {
      answerGoogle({ creditChanges: [lead('2026-05-01 10:00:00', 3, true, 3)] });
      await GoogleLsa.runDailySync();
      expect(windowOf()).toEqual({ metrics: ['2026-08-23', '2026-11-21'], leads: '2026-08-23' });
    });
  });

  test('a failed account step stops the run: no day is read or written', async () => {
    mockQuery.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncAccount: invalid_grant');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(insertCalls).toEqual([]);
    expect(updateCalls).toEqual([]);
  });

  test('a failed performance step fails the run', async () => {
    mockQuery.mockImplementation(async (gaql) => {
      if (/segments\.date/.test(gaql)) throw new Error('quota');
      return /FROM local_services_lead/.test(gaql) ? [] : [CAMPAIGN_ROW];
    });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncDailyPerformance: quota');
    expect(perfInserts()).toEqual([]);
  });

  test('a Google Ads SDK failure (an object with errors[], no message) still gives its reason', async () => {
    mockQuery.mockRejectedValueOnce({ errors: [{ message: 'The developer token is not approved.' }], request_id: 'abc' });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncAccount: The developer token is not approved.');
    expect(logger.error).toHaveBeenCalledWith('[google-lsa] syncAccount failed: The developer token is not approved.');
  });
});
