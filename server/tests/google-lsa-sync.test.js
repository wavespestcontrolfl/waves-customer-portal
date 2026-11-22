// Tests services/ads/google-lsa.js: the read-only Local Services Ads sync into
// the shared ad_campaigns / ad_performance_daily tables (platform='google_lsa').
// Behavior: the account signs in as itself, only Local Services campaigns are
// read, a day's conversions are always its leads charged and not credited back
// (counted once per account-day), a lead-only day still gets a row, the sync
// touches only rows with its account mark, and a failed step fails the run.
// Regression guarded: Local Services cost never reaching the Ads page, or a
// failed sync reading as a success.

let firstByTable = {};
let lsaCampaignRows = [];
let storedPerfRows = [];
const insertCalls = [];
const updateCalls = [];
const whereRawCalls = [];
const whereCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  let marked = false; // this builder already carries the account-mark filter
  b.where = jest.fn((...args) => { whereCalls.push({ table, args, afterMark: marked }); return b; });
  b.whereIn = jest.fn(() => b);
  b.whereRaw = jest.fn((sql, bindings) => { marked = true; whereRawCalls.push({ table, sql, bindings }); return b; });
  b.select = jest.fn(() => Promise.resolve(table === 'ad_campaigns' ? lsaCampaignRows : storedPerfRows));
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
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
const { customerId, mapStatus, mapCampaign, mapPerformanceRow, tallyLeadsByDay, leadCarrier, dateRange } = GoogleLsa._private;
const NO_LEADS = { total: 0, charged: 0, credited: 0, calls: 0, messages: 0, bookings: 0 };

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
  firstByTable = {};
  lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555', status: 'active' }];
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
      '2026-11-20': { total: 2, charged: 1, credited: 0, calls: 1, messages: 1, bookings: 0 },
      '2026-11-21': { total: 1, charged: 1, credited: 0, calls: 0, messages: 0, bookings: 1 },
    });
  });

  test('a lead Google credited back is not a charged lead; a pending credit still is', () => {
    const byDay = tallyLeadsByDay([
      lead('2026-11-20 09:15:00', 3, true, 3), // CREDITED: lead_charged stays true
      lead('2026-11-20 10:00:00', 3, true, 'CREDITED'),
      lead('2026-11-20 11:00:00', 3, true, 2), // PENDING
    ]);
    expect(byDay.get('2026-11-20')).toEqual({ total: 3, charged: 1, credited: 2, calls: 3, messages: 0, bookings: 0 });
  });

  test('leadCarrier: the campaign that ran that day carries its leads; a removed campaign keeps its own days', () => {
    const live = { id: 'local-1', platform_campaign_id: '555', status: 'active' };
    const removed = { id: 'local-0', platform_campaign_id: '444', status: 'removed' };
    const ranOn = (...ids) => new Map([['2026-11-01', new Set(ids)]]);
    expect(leadCarrier('2026-11-01', [live, removed], ranOn('555'))).toEqual({ campaignId: 'local-1', shared: false });
    expect(leadCarrier('2026-11-01', [live, removed], ranOn('444'))).toEqual({ campaignId: 'local-0', shared: false });
    // No metrics row that day: the one campaign that is not removed.
    expect(leadCarrier('2026-11-02', [live, removed], ranOn('444'))).toEqual({ campaignId: 'local-1', shared: false });
    // Only a removed campaign is left: it still carries the leads.
    expect(leadCarrier('2026-11-02', [removed], new Map())).toEqual({ campaignId: 'local-0', shared: false });
  });

  test('leadCarrier: more than one candidate = counted once on the lowest Google id, marked shared; no campaign row = null', () => {
    const a = { id: 'local-1', platform_campaign_id: '555', status: 'active' };
    const b = { id: 'local-2', platform_campaign_id: '90', status: 'paused' };
    expect(leadCarrier('2026-11-01', [a, b], new Map([['2026-11-01', new Set(['555', '90'])]]))).toEqual({ campaignId: 'local-2', shared: true });
    expect(leadCarrier('2026-11-01', [a, b], new Map())).toEqual({ campaignId: 'local-2', shared: true });
    expect(leadCarrier('2026-11-01', [], new Map())).toBeNull();
  });

  test('mapPerformanceRow: conversions = charged leads, Google\'s own number kept beside it', () => {
    const row = mapPerformanceRow(
      { impressions: 40, clicks: 4, cost_micros: 62000000, conversions: 3, conversions_value: 0, ctr: 0.1, average_cpc: 15500000 },
      { total: 3, charged: 2, credited: 0, calls: 2, messages: 1, bookings: 0 },
    );
    expect(row).toMatchObject({ impressions: 40, clicks: 4, cost: 62, conversions: 2, ctr: 10, avg_cpc: 15.5, roas: 0 });
    expect(JSON.parse(row.metadata)).toEqual({
      google_conversions: 3,
      lsa_leads: { total: 3, charged: 2, credited: 0, calls: 2, messages: 1, bookings: 0 },
    });
  });

  test('mapPerformanceRow on a row that carries no leads: zero conversions, never Google\'s number', () => {
    const row = mapPerformanceRow({ cost_micros: 31000000, conversions: 1 }, NO_LEADS);
    expect(row).toMatchObject({ cost: 31, conversions: 0 });
    expect(JSON.parse(row.metadata)).toEqual({ google_conversions: 1, lsa_leads: NO_LEADS });
  });

  test('dateRange is a window of Eastern calendar days', () => {
    expect(dateRange(30, new Date('2026-11-22T03:30:00Z'))).toEqual({ since: '2026-10-22', until: '2026-11-21' });
  });
});

describe('runDailySync', () => {
  const perfInserts = () => insertCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);

  test('every campaign query reads the Local Services channel only', async () => {
    await GoogleLsa.runDailySync();
    const campaignQueries = mockQuery.mock.calls.map(([gaql]) => gaql).filter((gaql) => /FROM campaign/.test(gaql));
    expect(campaignQueries).toHaveLength(2);
    for (const gaql of campaignQueries) expect(gaql).toContain("campaign.advertising_channel_type = 'LOCAL_SERVICES'");
    // No status filter: a removed campaign must still answer with its status and its last cost.
    for (const gaql of campaignQueries) expect(gaql).not.toMatch(/campaign\.status\s*!=/);
  });

  test('a new campaign is inserted as a google_lsa row marked with the account', async () => {
    const out = await GoogleLsa.runDailySync();
    const inserted = insertCalls.find((c) => c.table === 'ad_campaigns');
    expect(inserted.row).toMatchObject({
      platform: 'google_lsa', platform_campaign_id: '555', campaign_type: 'google_lsa', status: 'active', daily_budget_current: 25.5,
    });
    expect(JSON.parse(inserted.row.metadata)).toEqual({ lsa_customer_id: '7636809139' });
    expect(out).toEqual({ configured: true, synced: { campaigns: 1, performanceRows: 0 } });
  });

  test('a campaign row the sync owns is updated in place, and its metadata is left alone', async () => {
    firstByTable.ad_campaigns = { id: 'local-1', platform: 'google_lsa', platform_campaign_id: '555', status: 'paused', metadata: { lsa_customer_id: '7636809139', note: 'kept' } };
    await GoogleLsa.runDailySync();
    expect(insertCalls.filter((c) => c.table === 'ad_campaigns')).toEqual([]);
    const update = updateCalls.find((c) => c.table === 'ad_campaigns');
    expect(update.row).toMatchObject({ status: 'active' });
    expect(update.row).not.toHaveProperty('metadata');
  });

  test('the lookup for an existing campaign is scoped to the account mark: a hand-entered row with the same Google id is never taken over', async () => {
    await GoogleLsa.runDailySync();
    // The mock answers no marked row, so the campaign is inserted as its own
    // marked row; the lookup that could have found a row carried the mark filter.
    const lookup = whereCalls.find((w) => w.table === 'ad_campaigns' && w.args[0]?.platform_campaign_id === '555');
    expect(lookup.afterMark).toBe(true);
    expect(insertCalls.filter((c) => c.table === 'ad_campaigns')).toHaveLength(1);
    expect(updateCalls.filter((c) => c.table === 'ad_campaigns')).toEqual([]);
  });

  test('a campaign Google reports as removed is stored as removed', async () => {
    answerGoogle({ campaigns: [{ ...CAMPAIGN_ROW, campaign: { ...CAMPAIGN_ROW.campaign, status: 4 } }] });
    await GoogleLsa.runDailySync();
    expect(insertCalls.find((c) => c.table === 'ad_campaigns').row).toMatchObject({ status: 'removed' });
  });

  test('every read of campaign rows carries the account mark (the lookup and the performance step)', async () => {
    await GoogleLsa.runDailySync();
    expect(whereRawCalls).toEqual([
      { table: 'ad_campaigns', sql: "metadata ->> 'lsa_customer_id' = ?", bindings: ['7636809139'] },
      { table: 'ad_campaigns', sql: "metadata ->> 'lsa_customer_id' = ?", bindings: ['7636809139'] },
    ]);
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
    expect(JSON.parse(rows[0].metadata).lsa_leads).toEqual({ total: 2, charged: 1, credited: 0, calls: 1, messages: 1, bookings: 0 });
  });

  test('a metrics day with no lead reads zero conversions, not Google\'s number', async () => {
    answerGoogle({
      metrics: [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { impressions: 12, cost_micros: 0, conversions: 1 } }],
    });
    await GoogleLsa.runDailySync();
    expect(perfInserts()[0]).toMatchObject({ conversions: 0 });
  });

  test('with two live campaigns each lead is still counted once: on the campaign that ran that day, else shared on the first', async () => {
    lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555', status: 'active' }, { id: 'local-2', platform_campaign_id: '556', status: 'paused' }];
    answerGoogle({
      metrics: [{ campaign: { id: 556 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000, conversions: 4 } }],
      leads: [lead('2026-11-20 09:15:00', 3, true), lead('2026-11-21 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    const rows = perfInserts();
    expect(rows.map((r) => [r.campaign_id, r.date, r.conversions])).toEqual([
      ['local-2', '2026-11-20', 1], // the only campaign with a metrics row that day
      ['local-1', '2026-11-21', 1], // no metrics row: two candidates, first by Google id
    ]);
    expect(JSON.parse(rows[0].metadata)).toEqual({ google_conversions: 4, lsa_leads: { ...NO_LEADS, total: 1, charged: 1, calls: 1 } });
    expect(JSON.parse(rows[1].metadata).lsa_leads).toEqual({ ...NO_LEADS, total: 1, charged: 1, calls: 1, shared: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('leads with no campaign row to carry them are not written, and the log says how many', async () => {
    lsaCampaignRows = [];
    answerGoogle({ campaigns: [], leads: [lead('2026-11-20 09:15:00', 3, true), lead('2026-11-20 10:15:00', 2, false)] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 lead(s) not counted'));
  });

  test('a campaign removed since the last run still gets its cost, and its leads do not move to the live campaign', async () => {
    lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555', status: 'active' }, { id: 'local-0', platform_campaign_id: '444', status: 'removed' }];
    answerGoogle({
      metrics: [
        { campaign: { id: 444 }, segments: { date: '2026-11-18' }, metrics: { cost_micros: 31000000, conversions: 1 } },
        { campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 62000000, conversions: 2 } },
      ],
      leads: [lead('2026-11-18 09:15:00', 3, true), lead('2026-11-20 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    expect(perfInserts().map((r) => [r.campaign_id, r.date, r.cost, r.conversions])).toEqual([
      ['local-0', '2026-11-18', 31, 1],
      ['local-1', '2026-11-20', 62, 1],
    ]);
  });

  test('a metrics row for a campaign the portal does not hold is skipped', async () => {
    answerGoogle({ metrics: [{ campaign: { id: 999 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 5000000 } }] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
  });

  test('a stored day is updated, not inserted again', async () => {
    storedPerfRows = [{ id: 'perf-1', campaign_id: 'local-1', day: '2026-11-20' }];
    answerGoogle({ metrics: [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000 } }] });
    await GoogleLsa.runDailySync();
    expect(perfInserts()).toEqual([]);
    expect(updateCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row)).toEqual([
      expect.objectContaining({ campaign_id: 'local-1', date: '2026-11-20', cost: 31 }),
    ]);
  });

  test('a stored day Google no longer reports is written again as a zero day', async () => {
    storedPerfRows = [{ id: 'perf-9', campaign_id: 'local-1', day: '2026-11-19' }];
    await GoogleLsa.runDailySync(); // Google answers no metrics row and no lead
    const [reset] = updateCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);
    expect(reset).toMatchObject({ campaign_id: 'local-1', date: '2026-11-19', cost: 0, impressions: 0, conversions: 0 });
    expect(JSON.parse(reset.metadata).lsa_leads).toMatchObject({ total: 0, charged: 0 });
  });

  test('a stored day that no longer carries the day\'s leads loses its count', async () => {
    // An earlier run put the 11-19 lead on local-1. Now local-2 has that day's metrics row, so it carries the lead.
    lsaCampaignRows = [{ id: 'local-1', platform_campaign_id: '555', status: 'active' }, { id: 'local-2', platform_campaign_id: '556', status: 'active' }];
    storedPerfRows = [{ id: 'perf-7', campaign_id: 'local-1', day: '2026-11-19' }];
    answerGoogle({
      metrics: [{ campaign: { id: 556 }, segments: { date: '2026-11-19' }, metrics: { cost_micros: 31000000 } }],
      leads: [lead('2026-11-19 09:15:00', 3, true)],
    });
    await GoogleLsa.runDailySync();
    const [reset] = updateCalls.filter((c) => c.table === 'ad_performance_daily').map((c) => c.row);
    expect(reset).toMatchObject({ campaign_id: 'local-1', date: '2026-11-19', cost: 0, conversions: 0 });
    expect(perfInserts().map((r) => [r.campaign_id, r.date, r.conversions])).toEqual([['local-2', '2026-11-19', 1]]);
  });

  test('a late credit moves the start of the window back to the lead\'s own day', async () => {
    answerGoogle({ creditChanges: [lead('2026-10-01 14:00:00', 3, true, 3), lead('2026-11-10 14:00:00', 3, true, 2)] });
    jest.useFakeTimers({ now: new Date('2026-11-21T15:00:00Z') });
    try {
      await GoogleLsa.runDailySync();
    } finally { jest.useRealTimers(); }
    const queries = mockQuery.mock.calls.map(([gaql]) => gaql);
    expect(queries.find((q) => /credit_state_last_update_date_time/.test(q))).toContain(">= '2026-10-22 00:00:00'");
    expect(queries.find((q) => /segments\.date/.test(q))).toContain("BETWEEN '2026-10-01' AND '2026-11-21'");
    expect(queries.find((q) => /lead_charged/.test(q))).toContain("creation_date_time >= '2026-10-01 00:00:00'");
    expect(whereCalls).toContainEqual({ table: 'ad_performance_daily', args: ['date', '>=', '2026-10-01'], afterMark: false });
  });

  test('the window never starts before the 90 days the cost allocation recomputes', async () => {
    answerGoogle({ creditChanges: [lead('2026-06-03 14:00:00', 3, true, 3)] });
    jest.useFakeTimers({ now: new Date('2026-11-21T15:00:00Z') });
    try {
      await GoogleLsa.runDailySync();
    } finally { jest.useRealTimers(); }
    const queries = mockQuery.mock.calls.map(([gaql]) => gaql);
    expect(queries.find((q) => /segments\.date/.test(q))).toContain("BETWEEN '2026-08-23' AND '2026-11-21'");
  });

  test('a failed campaign step stops the run: the performance step does not run on a stale campaign list', async () => {
    mockQuery.mockImplementation(async (gaql) => {
      if (/FROM local_services_lead/.test(gaql)) return [];
      if (/segments\.date/.test(gaql)) return [{ campaign: { id: 555 }, segments: { date: '2026-11-20' }, metrics: { cost_micros: 31000000 } }];
      throw new Error('invalid_grant');
    });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncCampaigns: invalid_grant');
    expect(perfInserts()).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a failed performance step fails the run', async () => {
    mockQuery.mockImplementation(async (gaql) => {
      if (/segments\.date/.test(gaql)) throw new Error('quota');
      return /FROM local_services_lead/.test(gaql) ? [] : [CAMPAIGN_ROW];
    });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncDailyPerformance: quota');
  });

  test('a Google Ads SDK failure (an object with errors[], no message) still gives its reason', async () => {
    mockQuery.mockRejectedValue({ errors: [{ message: 'The caller does not have permission' }], request_id: 'abc' });
    await expect(GoogleLsa.runDailySync()).rejects.toThrow('syncCampaigns: The caller does not have permission');
    expect(logger.error).toHaveBeenCalledWith('[google-lsa] syncCampaigns failed: The caller does not have permission');
  });
});
