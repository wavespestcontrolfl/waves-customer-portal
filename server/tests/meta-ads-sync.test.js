// Tests services/ads/meta-ads.js — Meta Marketing API ingestion into the shared
// ad_campaigns / ad_performance_daily tables (platform='facebook').

let firstByTable = {};
const insertCalls = [];
const updateCalls = [];
const whereNotInCalls = [];
const whereNotNullCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereNot = jest.fn(() => b);
  b.whereNotNull = jest.fn((col) => { whereNotNullCalls.push({ table, col }); return b; });
  b.whereNotIn = jest.fn((col, ids) => { whereNotInCalls.push({ table, col, ids }); return b; });
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
const mockRunExclusive = jest.fn((_n, fn) => fn());
jest.mock('../utils/cron-lock', () => ({ runExclusive: (...a) => mockRunExclusive(...a) }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'uuid-1') }));

const MetaAds = require('../services/ads/meta-ads');
const { mapStatus, mapCampaign, mapInsightRow, sumActions, accountId } = MetaAds._private;

const env = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  firstByTable = {};
  insertCalls.length = 0;
  updateCalls.length = 0;
  whereNotInCalls.length = 0;
  whereNotNullCalls.length = 0;
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

  test('sumActions dedupes roll-up totals against their component events', () => {
    // Real Meta payload: the `lead` roll-up already includes the pixel lead, so
    // the aggregate wins — 2, not 2 + 3 = 5 (the old double-count).
    expect(sumActions([
      { action_type: 'lead', value: '2' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' },
      { action_type: 'landing_page_view', value: '99' },
    ])).toBe(2);

    // No aggregate present → fall back to summing the component events.
    expect(sumActions([
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' },
      { action_type: 'onsite_conversion.lead_grouped', value: '1' },
    ])).toBe(4);

    // Leads + purchases across groups add together; each group deduped.
    expect(sumActions([
      { action_type: 'lead', value: '2' },
      { action_type: 'omni_purchase', value: '5' },
      { action_type: 'purchase', value: '5' },
    ])).toBe(7);

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

describe('syncDailyPerformance pagination backstop', () => {
  test('a truncated insights walk fails the scheduler path (rows so far still persist)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], paging: { next: 'https://graph.facebook.com/more' } }),
    });
    await expect(MetaAds.syncDailyPerformance(7)).resolves.toEqual([]);
    await expect(MetaAds.syncDailyPerformance(7, { throwOnError: true })).rejects.toThrow(/insights: pagination incomplete/);
  });
});

describe('sync failure propagation (scheduler opt-in)', () => {
  const graphError = () => jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid token' } }) });

  test('syncCampaigns: default caller gets [] but { throwOnError } rethrows', async () => {
    global.fetch = graphError();
    await expect(MetaAds.syncCampaigns()).resolves.toEqual([]);
    await expect(MetaAds.syncCampaigns({ throwOnError: true })).rejects.toThrow('Invalid token');
  });

  test('syncDailyPerformance: default caller gets [] but { throwOnError } rethrows', async () => {
    global.fetch = graphError();
    await expect(MetaAds.syncDailyPerformance(7)).resolves.toEqual([]);
    await expect(MetaAds.syncDailyPerformance(7, { throwOnError: true })).rejects.toThrow('Invalid token');
  });

  test('the runExclusive body throws, so job_health records a failure (not success)', async () => {
    const seen = [];
    mockRunExclusive.mockImplementation(async (name, fn) => {
      try { return await fn(); } catch (err) { seen.push({ name, message: err.message }); throw err; }
    });
    global.fetch = graphError();
    await MetaAds.syncCampaigns();
    await MetaAds.syncDailyPerformance(7);
    mockRunExclusive.mockImplementation((_n, fn) => fn());
    expect(seen).toEqual([
      { name: 'meta-ads-campaigns', message: expect.stringContaining('Invalid token') },
      { name: 'meta-ads-performance', message: expect.stringContaining('Invalid token') },
    ]);
  });

  test('not configured stays a silent no-op even with throwOnError', async () => {
    delete process.env.META_ADS_ACCESS_TOKEN;
    global.fetch = jest.fn();
    await expect(MetaAds.syncCampaigns({ throwOnError: true })).resolves.toEqual([]);
    await expect(MetaAds.syncDailyPerformance(7, { throwOnError: true })).resolves.toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('syncCampaigns removed-campaign reconcile', () => {
  const page = (data, next) => ({ ok: true, json: async () => ({ data, paging: next ? { next } : {} }) });
  const removedUpdates = () => updateCalls.filter((u) => u.table === 'ad_campaigns' && u.row.status === 'removed');

  test('marks facebook rows Meta no longer returns as removed after a complete fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue(page([{ id: 'c1', name: 'Lead Gen', effective_status: 'ACTIVE' }]));
    firstByTable.ad_campaigns = undefined;

    await MetaAds.syncCampaigns();

    expect(whereNotInCalls).toEqual([{ table: 'ad_campaigns', col: 'platform_campaign_id', ids: ['c1'] }]);
    expect(removedUpdates()).toHaveLength(1);
    expect(removedUpdates()[0].row.updated_at).toBeInstanceOf(Date);
  });

  test('an empty successful response marks every facebook row removed', async () => {
    global.fetch = jest.fn().mockResolvedValue(page([]));

    await MetaAds.syncCampaigns();

    expect(whereNotInCalls).toEqual([{ table: 'ad_campaigns', col: 'platform_campaign_id', ids: [] }]);
    // An empty NOT IN compiles to always-true, so manual NULL-id rows need this fence.
    expect(whereNotNullCalls).toEqual([{ table: 'ad_campaigns', col: 'platform_campaign_id' }]);
    expect(removedUpdates()).toHaveLength(1);
  });

  test.each([
    ['unparseable JSON', { ok: true, json: async () => { throw new SyntaxError('bad json'); } }],
    ['a 200 page with no data array', { ok: true, json: async () => ({ paging: {} }) }],
  ])('does NOT reconcile on %s, and the scheduler path fails', async (_label, resp) => {
    global.fetch = jest.fn().mockResolvedValue(resp);

    await expect(MetaAds.syncCampaigns()).resolves.toEqual([]);
    await expect(MetaAds.syncCampaigns({ throwOnError: true })).rejects.toThrow(/Meta API campaigns/);
    expect(whereNotInCalls).toHaveLength(0);
    expect(removedUpdates()).toHaveLength(0);
  });

  test('follows paging before reconciling, so a campaign on page 2 is not removed', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(page([{ id: 'c1', name: 'A', effective_status: 'ACTIVE' }], 'https://graph.facebook.com/next'))
      .mockResolvedValueOnce(page([{ id: 'c2', name: 'B', effective_status: 'PAUSED' }]));
    firstByTable.ad_campaigns = undefined;

    await MetaAds.syncCampaigns();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(whereNotInCalls[0].ids).toEqual(['c1', 'c2']);
  });

  test('does NOT reconcile when the fetch errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });

    await MetaAds.syncCampaigns();

    expect(whereNotInCalls).toHaveLength(0);
    expect(removedUpdates()).toHaveLength(0);
  });

  test('does NOT reconcile when pagination hits the page backstop (incomplete list)', async () => {
    // Every response advertises another page; the 25-page backstop ends the walk early.
    global.fetch = jest.fn().mockResolvedValue(page([], 'https://graph.facebook.com/more'));

    await expect(MetaAds.syncCampaigns()).resolves.toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(25);
    // The scheduler path fails the job instead of recording a healthy partial sync.
    await expect(MetaAds.syncCampaigns({ throwOnError: true })).rejects.toThrow(/pagination incomplete/);
    expect(whereNotInCalls).toHaveLength(0);
    expect(removedUpdates()).toHaveLength(0);
  });
});
