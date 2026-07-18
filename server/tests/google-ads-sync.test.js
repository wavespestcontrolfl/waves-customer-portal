const mockQueryFirst = jest.fn();
const mockInsertReturning = jest.fn();
const mockInsert = jest.fn(() => ({ returning: mockInsertReturning }));
const mockUpdate = jest.fn();
const mockWhere = jest.fn(() => {
  const chain = { first: mockQueryFirst, update: mockUpdate, forUpdate: jest.fn(() => chain) };
  return chain;
});
const mockDb = jest.fn(() => ({ where: mockWhere, insert: mockInsert }));
// syncCampaigns upserts inside a row-locked transaction now.
mockDb.transaction = (cb) => cb(mockDb);
mockDb.fn = { now: () => 'NOW()' };

jest.mock('../models/db', () => mockDb);

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const mockCustomerQuery = jest.fn();
const mockMutateResources = jest.fn();
const mockCustomerFactory = jest.fn(() => ({
  query: mockCustomerQuery,
  mutateResources: mockMutateResources,
}));
const mockGoogleAdsApi = jest.fn(() => ({ Customer: mockCustomerFactory }));

jest.mock('google-ads-api', () => ({
  GoogleAdsApi: mockGoogleAdsApi,
  enums: {
    CampaignStatus: {
      2: 'ENABLED',
      3: 'PAUSED',
      4: 'REMOVED',
      ENABLED: 2,
      PAUSED: 3,
      REMOVED: 4,
    },
  },
}));
// google-ads-api and uuid are REAL installed packages — these mocks must NOT
// be `virtual: true`. A virtual mock is registered under a synthesized name
// key instead of the resolved module path, and in a shared jest worker whose
// caches were warmed by an earlier suite the service's require can resolve
// straight to the real library, bypassing the mock — which is how this suite
// went red only in CI (syncCampaigns made a live OAuth call and swallowed
// "invalid_client", so every configured-path test saw [] / null).

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-1'),
}));

const GoogleAds = require('../services/ads/google-ads');

describe('Google Ads campaign sync', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...env,
      GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
      GOOGLE_ADS_CLIENT_ID: 'client-id',
      GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
      GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
      GOOGLE_ADS_CUSTOMER_ID: '3393936713',
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '8507694331',
    };
  });

  afterAll(() => {
    process.env = env;
  });

  test('writes Google budgets into the existing ad_campaigns budget columns', async () => {
    mockQueryFirst.mockResolvedValue(null);
    mockInsertReturning.mockResolvedValue([{
      id: 'uuid-1',
      platform_campaign_id: '22594274874',
      status: 'paused',
      daily_budget_base: 5,
      daily_budget_current: 5,
    }]);
    mockCustomerQuery.mockResolvedValue([{
      campaign: {
        id: '22594274874',
        name: 'Waves Pest Control - GBP Search',
        status: 3,
        advertising_channel_type: 'SEARCH',
      },
      campaign_budget: {
        amount_micros: 5_000_000,
      },
    }]);

    const results = await GoogleAds.syncCampaigns();

    // TEMPORARY CI DIAGNOSTIC (remove before merge): in the CI no-DB job this
    // suite fails with results=[] while isConfigured() is TRUE (round 1 proved
    // the env swap works), which means syncCampaigns threw internally and the
    // catch swallowed the error into the mocked logger. Surface it, plus which
    // of this file's mocks actually ran. Messages only — no env values.
    if (results.length !== 1) {
      const logger = require('../services/logger');
      throw new Error('CI-DIAG syncCampaigns empty. '
        + `loggerErrors=${JSON.stringify(logger.error.mock.calls)} `
        + `loggerWarns=${JSON.stringify(logger.warn.mock.calls)} `
        + `apiCtor=${mockGoogleAdsApi.mock.calls.length} `
        + `customerFactory=${mockCustomerFactory.mock.calls.length} `
        + `query=${mockCustomerQuery.mock.calls.length}`);
    }

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('paused');
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'google_ads',
      platform_campaign_id: '22594274874',
      status: 'paused',
      daily_budget_base: 5,
      daily_budget_current: 5,
    }));
    expect(mockInsert.mock.calls[0][0]).not.toHaveProperty('daily_budget');
  });

  test('preserves daily_budget_base while the local row is throttled', async () => {
    // A pushed capacity throttle (stop = 1% of base) read back from Google
    // must not become the new canonical base — a later green-capacity run
    // could never restore full spend.
    mockQueryFirst.mockResolvedValue({
      id: 'row-1',
      platform_campaign_id: '22594274874',
      budget_mode: 'stop',
      daily_budget_base: 40,
    });
    mockUpdate.mockResolvedValue(1);
    mockCustomerQuery.mockResolvedValue([{
      campaign: { id: '22594274874', name: 'Sarasota Pest', status: 2, advertising_channel_type: 'SEARCH' },
      campaign_budget: { amount_micros: 400_000 },
    }]);

    const results = await GoogleAds.syncCampaigns();

    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg).not.toHaveProperty('daily_budget_base');
    expect(updateArg.daily_budget_current).toBe(0.4);
    expect(results[0].daily_budget_base).toBe(40);
  });

  test('preserves stored base in base mode too — a failed restore leaves the throttle live', async () => {
    // setMode back to 'base' commits mode='base' locally even when the push
    // fails, so Google can still be running the old $0.40 throttle at the
    // next sync. Trusting that live amount as the new base would leave the
    // campaign permanently throttled (reconcile would "enforce" $0.40); a
    // legitimate Ads-Manager edit is indistinguishable from this state, so
    // base only ever changes through /admin/ads setBudget.
    mockQueryFirst.mockResolvedValue({
      id: 'row-1',
      platform_campaign_id: '22594274874',
      budget_mode: 'base',
      daily_budget_base: 40,
    });
    mockUpdate.mockResolvedValue(1);
    mockCustomerQuery.mockResolvedValue([{
      campaign: { id: '22594274874', name: 'Sarasota Pest', status: 2, advertising_channel_type: 'SEARCH' },
      campaign_budget: { amount_micros: 400_000 },
    }]);

    const results = await GoogleAds.syncCampaigns();

    const updateArg = mockUpdate.mock.calls[0][0];
    expect(updateArg).not.toHaveProperty('daily_budget_base');
    expect(updateArg.daily_budget_current).toBe(0.4);
    expect(results[0].daily_budget_base).toBe(40);
  });

  test('backfills base from live only when the stored base is null', async () => {
    mockQueryFirst.mockResolvedValue({
      id: 'row-1',
      platform_campaign_id: '22594274874',
      budget_mode: null,
      daily_budget_base: null,
    });
    mockUpdate.mockResolvedValue(1);
    mockCustomerQuery.mockResolvedValue([{
      campaign: { id: '22594274874', name: 'Sarasota Pest', status: 2, advertising_channel_type: 'SEARCH' },
      campaign_budget: { amount_micros: 45_000_000 },
    }]);

    await GoogleAds.syncCampaigns();

    expect(mockUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({
      daily_budget_base: 45,
      daily_budget_current: 45,
    }));
  });

  test('enables campaigns using the current mutateResources update format', async () => {
    mockMutateResources.mockResolvedValue({});

    const result = await GoogleAds.enableCampaign('22594274874');

    expect(result).toEqual({
      success: true,
      platformCampaignId: '22594274874',
      status: 'active',
    });
    expect(mockMutateResources).toHaveBeenCalledWith([{
      entity: 'campaign',
      operation: 'update',
      resource: {
        resource_name: 'customers/3393936713/campaigns/22594274874',
        status: 2,
      },
    }]);
  });

  test('pauses campaigns using the current mutateResources update format', async () => {
    mockMutateResources.mockResolvedValue({});

    const result = await GoogleAds.pauseCampaign('22594274874');

    expect(result).toEqual({
      success: true,
      platformCampaignId: '22594274874',
      status: 'paused',
    });
    expect(mockMutateResources).toHaveBeenCalledWith([{
      entity: 'campaign',
      operation: 'update',
      resource: {
        resource_name: 'customers/3393936713/campaigns/22594274874',
        status: 3,
      },
    }]);
  });

  test('updates campaign budgets using the current mutateResources update format', async () => {
    mockCustomerQuery.mockResolvedValue([{
      campaign: {
        id: '22594274874',
        campaign_budget: 'customers/3393936713/campaignBudgets/987654321',
      },
      campaign_budget: { amount_micros: '4000000' },
    }]);
    mockMutateResources.mockResolvedValue({});

    const result = await GoogleAds.updateBudget('22594274874', 5);

    expect(result).toEqual({
      success: true,
      platformCampaignId: '22594274874',
      dailyBudget: 5,
      // The pre-mutation live amount, observed by the same query that
      // resolves the budget resource — rollback restore target.
      previousDailyBudget: 4,
    });
    expect(mockMutateResources).toHaveBeenCalledWith([{
      entity: 'campaign_budget',
      operation: 'update',
      resource: {
        resource_name: 'customers/3393936713/campaignBudgets/987654321',
        amount_micros: 5000000,
      },
    }]);
  });

  test('refuses to update a SHARED campaign budget', async () => {
    // A shared budget backs multiple campaigns — one row's capacity push
    // would throttle every campaign on it.
    mockCustomerQuery.mockResolvedValue([{
      campaign: {
        id: '22594274874',
        campaign_budget: 'customers/3393936713/campaignBudgets/987654321',
      },
      campaign_budget: {
        explicitly_shared: true,
      },
    }]);

    const result = await GoogleAds.updateBudget('22594274874', 5);

    expect(result).toBeNull();
    expect(mockMutateResources).not.toHaveBeenCalled();
  });

  test('gaqlDateRange returns a finite, dashed YYYY-MM-DD range', () => {
    const { since, until } = GoogleAds._private.gaqlDateRange(7, new Date('2026-06-27T12:00:00Z'));
    expect(since).toBe('2026-06-20');
    expect(until).toBe('2026-06-27');
    // dashed literals, NOT the old 'YYYYMMDD' that Google rejects
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('syncDailyPerformance uses a bounded segments.date BETWEEN range (not open-ended >=)', async () => {
    mockCustomerQuery.mockResolvedValue([]); // no rows → no db work; we only inspect the query
    await GoogleAds.syncDailyPerformance(7);
    const gaql = mockCustomerQuery.mock.calls[0][0];
    // Google Ads rejects an open-ended segments.date filter (query_error 55).
    expect(gaql).toMatch(/segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    expect(gaql).not.toMatch(/segments\.date >=/);
  });

  test('syncSearchTerms also uses a bounded BETWEEN range', async () => {
    mockCustomerQuery.mockResolvedValue([]);
    await GoogleAds.syncSearchTerms(30);
    const gaql = mockCustomerQuery.mock.calls[0][0];
    expect(gaql).toMatch(/segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'/);
    expect(gaql).not.toMatch(/segments\.date >=/);
  });
});

describe('sync freshness fence (r12)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...process.env,
      GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
      GOOGLE_ADS_CLIENT_ID: 'client-id',
      GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
      GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
      GOOGLE_ADS_CUSTOMER_ID: '3393936713',
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '8507694331',
    };
  });

  it('skips a row a local writer touched after the sync fetch began', async () => {
    mockCustomerQuery.mockResolvedValue([{
      campaign: { id: 111, name: 'Pest Bradenton', status: 2, advertising_channel_type: 'SEARCH' },
      campaign_budget: { amount_micros: 30_000_000 },
      metrics: {},
    }]);
    // The locked re-read shows the row was updated AFTER fetchStartedAt —
    // e.g. a compensating rollback restored a failed push mid-sync. Writing
    // our pre-rollback observation would resurrect the failed amount.
    mockQueryFirst.mockResolvedValue({
      id: 'row-1', daily_budget_base: '40', daily_budget_current: '40',
      updated_at: new Date(Date.now() + 60_000),
    });

    const results = await GoogleAds.syncCampaigns();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(results).toHaveLength(1); // still reported, from local state
  });

  it('still mirrors a row untouched since before the fetch', async () => {
    mockCustomerQuery.mockResolvedValue([{
      campaign: { id: 111, name: 'Pest Bradenton', status: 2, advertising_channel_type: 'SEARCH' },
      campaign_budget: { amount_micros: 30_000_000 },
      metrics: {},
    }]);
    mockQueryFirst.mockResolvedValue({
      id: 'row-1', daily_budget_base: '40', daily_budget_current: '40',
      updated_at: new Date(Date.now() - 3600_000),
    });

    await GoogleAds.syncCampaigns();

    expect(mockUpdate).toHaveBeenCalled();
  });
});
