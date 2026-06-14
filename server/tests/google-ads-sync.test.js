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
const mockCustomerFactory = jest.fn(() => ({ query: mockCustomerQuery }));
const mockGoogleAdsApi = jest.fn(() => ({ Customer: mockCustomerFactory }));

jest.mock('google-ads-api', () => ({
  GoogleAdsApi: mockGoogleAdsApi,
  enums: {
    CampaignStatus: {
      ENABLED: 'ENABLED',
      PAUSED: 'PAUSED',
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
      daily_budget_base: 5,
      daily_budget_current: 5,
    }]);
    mockCustomerQuery.mockResolvedValue([{
      campaign: {
        id: '22594274874',
        name: 'Waves Pest Control - GBP Search',
        status: 'PAUSED',
        advertising_channel_type: 'SEARCH',
      },
      campaign_budget: {
        amount_micros: 5_000_000,
      },
    }]);

    const results = await GoogleAds.syncCampaigns();

    expect(results).toHaveLength(1);
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'google_ads',
      platform_campaign_id: '22594274874',
      daily_budget_base: 5,
      daily_budget_current: 5,
    }));
    expect(mockInsert.mock.calls[0][0]).not.toHaveProperty('daily_budget');
  });
});
