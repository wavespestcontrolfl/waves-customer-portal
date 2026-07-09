// adjustBudgets must push budget changes to the Google Ads API (push-first,
// commit local state only on success) when the adsBudgetLivePush gate is on,
// and keep the legacy DB-only intent tracking when the gate is off, the
// campaign is unlinked, or the API is unconfigured. Gate-on runs with no mode
// transition reconcile drift: a recorded mode whose calculated budget doesn't
// match daily_budget_current (mode shadow-written while the gate was off,
// then the daily sync restored Google's live amount) is re-pushed. setMode
// mirrors the manual /campaigns/:id/budget route: DB first, best-effort push,
// outcome reported via googleAdsUpdated.

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

    test('gate on but NULL base: DB-only — the $20 fallback never reaches Google', async () => {
      campaignRows = [{ ...baseCampaign(), daily_budget_base: null }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      // Legacy intent tracking still runs: stop = 1% of the $20 fallback.
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        budget_mode: 'stop',
        daily_budget_current: 0.2,
      });
    });
  });

  describe('adjustBudgets reconcile (no transition, gate on)', () => {
    test('shadowed stop mode pushed once the gate turns on', async () => {
      // Shadow run (gate off) already set budget_mode='stop'; the 6AM sync
      // then wrote Google's live 40 back into daily_budget_current. Same
      // capacity zone → no transition, but stop's budget (1% of base = 0.4)
      // was never live on Google.
      campaignRows = [{ ...baseCampaign(), budget_mode: 'stop', daily_budget_current: '40' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.4);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 0.4 });
      expect(mockLogInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          previous_mode: 'stop',
          new_mode: 'stop',
          new_budget: 0.4,
          trigger: 'auto',
          reason: expect.stringContaining('Reconcile'),
        })
      );
    });

    test('no reconcile when the mode budget is already live', async () => {
      campaignRows = [{ ...baseCampaign(), budget_mode: 'stop', daily_budget_current: '0.4' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('gate off: shadowed drift is left alone (no push, no writes)', async () => {
      campaignRows = [{ ...baseCampaign(), budget_mode: 'stop', daily_budget_current: '40' }];
      mockIsEnabled.mockReturnValue(false);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
    });

    test('reconcile push failure: local state untouched, retried next run', async () => {
      campaignRows = [{ ...baseCampaign(), budget_mode: 'stop', daily_budget_current: '40' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('failed restore-to-base heals: sync-restored throttle re-pushed up to base', async () => {
      // setMode('base') committed mode='base' but the push failed, so Google
      // kept running the $0.40 throttle; the 6AM sync wrote that live amount
      // into daily_budget_current (base preserved — sync never overwrites
      // it). Green capacity → newMode 'base' matches → reconcile restores
      // full spend.
      BudgetManager.getCapacityForArea.mockResolvedValue({ utilizationPct: 50, booked: 4, slots: 8, techs: 1 });
      campaignRows = [{ ...baseCampaign(), budget_mode: 'base', daily_budget_current: '0.4' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 40);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 40 });
    });

    test('half-cent stop budget does not thrash: cents-rounded on both sides', async () => {
      // base 30.50 → raw 1% is 0.305, but decimal(10,2) stores 0.31. The
      // calculation cent-rounds and the drift check compares integer cents,
      // so an already-reconciled campaign must not re-push every run.
      campaignRows = [{
        ...baseCampaign(),
        daily_budget_base: '30.50',
        budget_mode: 'stop',
        daily_budget_current: '0.31',
      }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
    });

    test('null daily_budget_current (never synced) is skipped, not treated as drift', async () => {
      campaignRows = [{ ...baseCampaign(), budget_mode: 'stop', daily_budget_current: null }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
    });

    test('NULL base: no reconcile push — fallback-derived budgets stay local', async () => {
      campaignRows = [{ ...baseCampaign(), daily_budget_base: null, budget_mode: 'stop', daily_budget_current: '40' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
    });

    test("'spent' mode never reconciles — freeze-at-current is identity", async () => {
      // 80% utilization → 'spent' zone, matching the recorded mode.
      BudgetManager.getCapacityForArea.mockResolvedValue({ utilizationPct: 80, booked: 6, slots: 8, techs: 1 });
      campaignRows = [{ ...baseCampaign(), budget_mode: 'spent', daily_budget_current: '37.5' }];
      mockIsEnabled.mockReturnValue(true);
      mockIsConfigured.mockReturnValue(true);

      await BudgetManager.adjustBudgets();

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
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

    test('invalid mode rejected before any write or push', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);

      await expect(BudgetManager.setMode('c-1', 'pause', 'test'))
        .rejects.toThrow(/Invalid budget mode/);

      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
    });

    test('NULL base: DB updated but no push, googleAdsUpdated false', async () => {
      campaignFirstRow = { ...baseCampaign(), daily_budget_base: null };
      mockIsConfigured.mockReturnValue(true);

      const result = await BudgetManager.setMode('c-1', 'stop', 'test');

      expect(mockCampaignUpdate).toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(false);
    });
  });
});
