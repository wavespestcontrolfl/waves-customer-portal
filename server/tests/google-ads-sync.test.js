const mockQueryFirst = jest.fn();
const mockInsertReturning = jest.fn();
const mockInsert = jest.fn(() => ({ returning: mockInsertReturning }));
const mockUpdate = jest.fn();
const mockWhere = jest.fn(() => ({ first: mockQueryFirst, update: mockUpdate }));
const mockDb = jest.fn(() => ({ where: mockWhere, insert: mockInsert }));

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
}), { virtual: true });

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-1'),
}), { virtual: true });

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

  test('writes live budget into base when the local row is in base mode', async () => {
    mockQueryFirst.mockResolvedValue({
      id: 'row-1',
      platform_campaign_id: '22594274874',
      budget_mode: 'base',
      daily_budget_base: 40,
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
    }]);
    mockMutateResources.mockResolvedValue({});

    const result = await GoogleAds.updateBudget('22594274874', 5);

    expect(result).toEqual({
      success: true,
      platformCampaignId: '22594274874',
      dailyBudget: 5,
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
