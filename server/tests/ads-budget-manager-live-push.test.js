// adjustBudgets must push budget changes to the Google Ads API (push-first,
// commit local state only on success) when the adsBudgetLivePush gate is on,
// and keep the legacy DB-only intent tracking when the gate is off, the
// campaign is unlinked, or the API is unconfigured. setMode mirrors the manual
// /campaigns/:id/budget route: DB first, best-effort push, outcome reported
// via googleAdsUpdated.

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({ isEnabled: mockIsEnabled }));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const mockIsConfigured = jest.fn();
const mockUpdateBudget = jest.fn();
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: mockIsConfigured,
  updateBudget: mockUpdateBudget,
}));

// db(table) dispatch: the active-campaign list query awaits the ad_campaigns
// builder itself (thenable); targeted lookups/writes resolve through
// first()/update()/insert().
const mockCampaignUpdate = jest.fn().mockResolvedValue(1);
const mockLogInsert = jest.fn().mockResolvedValue([]);
let campaignRows = [];
let campaignFirstRow = null;

const mockDb = jest.fn((table) => {
  if (table === 'ad_campaigns') {
    const builder = {
      where: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(campaignFirstRow)),
      update: mockCampaignUpdate,
      then: (resolve, reject) => Promise.resolve(campaignRows).then(resolve, reject),
    };
    return builder;
  }
  if (table === 'ad_targets') {
    // Empty row → thresholds fall back to defaults (70/85/95).
    return { first: jest.fn(() => Promise.resolve({})) };
  }
  if (table === 'ad_budget_log') {
    return { insert: mockLogInsert };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});
jest.mock('../models/db', () => mockDb);

const BudgetManager = require('../services/ads/budget-manager');

const baseCampaign = () => ({
  id: 'c-1',
  campaign_name: 'Sarasota Pest',
  platform: 'google_ads',
  platform_campaign_id: '1234567890',
  target_area: 'Sarasota',
  budget_mode: 'base',
  daily_budget_base: '40',
  daily_budget_current: '40',
  status: 'active',
});

describe('BudgetManager live Google Ads push', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    campaignRows = [];
    campaignFirstRow = null;
    // 99% utilization → above the default orange max (95) → mode 'stop'
    // (a change from 'base'), so every adjustBudgets test exercises a write.
    jest.spyOn(BudgetManager, 'getCapacityForArea')
      .mockResolvedValue({ utilizationPct: 99, booked: 8, slots: 8, techs: 1 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('adjustBudgets (autonomous cron)', () => {
    test('gate on + linked + configured: pushes to Google first, then commits locally', async () => {
      campaignRows = [baseCampaign()];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      await BudgetManager.adjustBudgets();

      // stop mode = max(0.01, base * 0.01) = 0.4
      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.4);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        budget_mode: 'stop',
        daily_budget_current: 0.4,
      });
      expect(mockLogInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          new_mode: 'stop',
          trigger: 'auto',
          reason: expect.stringContaining('pushed to Google Ads'),
        })
      );
    });

    test('gate on + push fails: no local write, so the next run retries', async () => {
      campaignRows = [baseCampaign()];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('gate off: legacy DB-only intent tracking, no API call', async () => {
      campaignRows = [baseCampaign()];
      mockIsEnabled.mockReturnValue(false);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        budget_mode: 'stop',
        daily_budget_current: 0.4,
      });
      expect(mockLogInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.not.stringContaining('pushed to Google Ads'),
        })
      );
    });

    test('gate on but campaign not linked to Google: DB-only, no push attempt', async () => {
      campaignRows = [{ ...baseCampaign(), platform_campaign_id: null }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).toHaveBeenCalled();
    });

    test('gate on but API unconfigured: DB-only, no push attempt', async () => {
      campaignRows = [baseCampaign()];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(false);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).toHaveBeenCalled();
    });
  });

  describe('setMode (manual: admin mode button / advisor Apply)', () => {
    test('linked + configured: updates DB then pushes, reports googleAdsUpdated', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      const result = await BudgetManager.setMode('c-1', 'stop', 'test');

      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        budget_mode: 'stop',
        daily_budget_current: 0.4,
      });
      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.4);
      expect(result.googleAdsUpdated).toBe(true);
    });

    test('unconfigured API: DB still updated, googleAdsUpdated false', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(false);

      const result = await BudgetManager.setMode('c-1', 'stop', 'test');

      expect(mockCampaignUpdate).toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(false);
    });

    test('push failure surfaces as googleAdsUpdated false (local change kept)', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null);

      const result = await BudgetManager.setMode('c-1', 'stop', 'test');

      expect(mockCampaignUpdate).toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(false);
    });
  });
});
