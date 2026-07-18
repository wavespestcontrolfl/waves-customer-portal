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
// Row returned by the rollback's newer-writer audit lookup (null = no real
// writer committed since the operation started).
let mockNewerAuditRow = null;
// Row returned for the rollback's OWN-op lookup (non-null = the "failed"
// transaction actually committed; its acknowledgement was lost).
let mockOwnOpRow = null;

const mockDb = jest.fn((table) => {
  if (table === 'ad_campaigns') {
    const builder = {
      where: jest.fn(() => builder),
      forUpdate: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(campaignFirstRow ?? campaignRows[0] ?? null)),
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
    let ownOpLookup = false;
    const b = {
      insert: mockLogInsert,
      where: jest.fn((arg) => {
        if (arg && typeof arg === 'object' && 'op_id' in arg) ownOpLookup = true;
        return b;
      }),
      whereNull: jest.fn(() => b),
      orWhereNot: jest.fn(() => b),
      first: jest.fn(() => Promise.resolve(ownOpLookup ? mockOwnOpRow : mockNewerAuditRow)),
      // The supersession check selects ALL newer audit rows and inspects
      // google_ads_updated per row in JS.
      select: jest.fn(() => Promise.resolve(mockNewerAuditRow ? [mockNewerAuditRow] : [])),
    };
    return b;
  }
  throw new Error(`Unexpected table in test: ${table}`);
});
// requireLivePush runs inside db.transaction with a FOR UPDATE row lock;
// the mock trx is the same dispatcher (rollback semantics are the DB's job —
// these tests assert WHICH writes were attempted).
mockDb.transaction = (cb) => cb(mockDb);
// knex's fn.now() used for updated_at bumps.
mockDb.fn = { now: () => 'NOW()' };
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
    mockNewerAuditRow = null;
    mockOwnOpRow = null;
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
        updated_at: expect.any(Date),
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
        updated_at: expect.any(Date),
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
        updated_at: expect.any(Date),
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
      expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 0.4, updated_at: expect.any(Date) });
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
      expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 40, updated_at: expect.any(Date) });
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
        updated_at: expect.any(Date),
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

  describe('setBudget (manual: base change)', () => {
    test('base mode: pushes the new base and syncs current, reports googleAdsUpdated', async () => {
      campaignFirstRow = baseCampaign(); // budget_mode 'base', base/current 40
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      const result = await BudgetManager.setBudget('c-1', 50, 'test');

      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        daily_budget_base: 50,
        daily_budget_current: 50,
        updated_at: expect.any(Date),
      });
      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 50);
      expect(result).toMatchObject({ newBudget: 50, effectiveBudget: 50, googleAdsUpdated: true });
    });

    test('stop mode: pushes the mode-derived 1%, NOT the raw new base, and leaves current frozen', async () => {
      campaignFirstRow = { ...baseCampaign(), budget_mode: 'stop', daily_budget_current: '0.4' };
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      const result = await BudgetManager.setBudget('c-1', 50, 'test');

      // base recorded; Google gets 1% of the NEW base (0.5), never the raw 50
      // that would blast full spend during a stop; current advances to the new
      // throttle so the dashboard/reconcile stay consistent.
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        daily_budget_base: 50,
        daily_budget_current: 0.5,
        updated_at: expect.any(Date),
      });
      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.5);
      expect(result.effectiveBudget).toBe(0.5);
    });

    test('invalid or non-positive amount rejected before any write or push', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);

      await expect(BudgetManager.setBudget('c-1', 'abc', 'test')).rejects.toThrow(/Invalid budget/);
      await expect(BudgetManager.setBudget('c-1', '50junk', 'test')).rejects.toThrow(/Invalid budget/);
      await expect(BudgetManager.setBudget('c-1', -5, 'test')).rejects.toThrow(/Invalid budget/);
      await expect(BudgetManager.setBudget('c-1', 0, 'test')).rejects.toThrow(/Invalid budget/);
      // 0.004 passes the > 0 check but rounds to $0 — must be rejected too.
      await expect(BudgetManager.setBudget('c-1', 0.004, 'test')).rejects.toThrow(/rounds to \$0|minimum/);

      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
    });

    test('over-max budget rejected before any push (decimal(10,2) storable cap)', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);

      // 100000000 exceeds decimal(10,2)'s 99999999.99 — must be rejected BEFORE
      // the Google push, so the live campaign can't change and then fail the DB write.
      await expect(BudgetManager.setBudget('c-1', 100000000, 'test')).rejects.toThrow(/exceeds the maximum/);

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('unconfigured API: base + current advance (intent tracking), no push', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(false);

      const result = await BudgetManager.setBudget('c-1', 50, 'test');

      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        daily_budget_base: 50,
        daily_budget_current: 50,
        updated_at: expect.any(Date),
      });
      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(false);
    });

    test('push failure: base recorded but current stays at the old live amount', async () => {
      campaignFirstRow = baseCampaign(); // current '40'
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null); // Google refused (e.g. shared budget)

      const result = await BudgetManager.setBudget('c-1', 50, 'test');

      // Google still runs the old budget, so current must NOT claim the new one.
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        daily_budget_base: 50,
        daily_budget_current: '40',
        updated_at: expect.any(Date),
      });
      expect(result.googleAdsUpdated).toBe(false);
    });
  });

  // requireLivePush (advisor apply): a linked campaign's push runs FIRST and
  // a refused/unrunnable push throws BEFORE any DB write — a failed apply
  // must leave no recorded intent for the reconcile cron to re-push later.
  describe('requireLivePush (advisor apply contract)', () => {
    test('setBudget: refused push throws live_push_failed and persists NOTHING', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null); // Google refused

      await expect(BudgetManager.setBudget('c-1', 50, 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_failed' });

      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('setBudget: linked but unconfigured throws live_push_unavailable, persists NOTHING', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(false);

      await expect(BudgetManager.setBudget('c-1', 50, 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_unavailable' });

      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
    });

    test('setMode: pushes FIRST; refused push throws and persists NOTHING', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue(null);

      await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_failed' });

      expect(mockUpdateBudget).toHaveBeenCalled(); // push attempted first…
      expect(mockCampaignUpdate).not.toHaveBeenCalled(); // …but nothing written
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('setMode: linked with NULL base cannot push → live_push_unavailable, persists NOTHING', async () => {
      campaignFirstRow = { ...baseCampaign(), daily_budget_base: null };
      mockIsConfigured.mockReturnValue(true);

      await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_unavailable' });

      expect(mockCampaignUpdate).not.toHaveBeenCalled();
      expect(mockUpdateBudget).not.toHaveBeenCalled();
    });

    test('setMode: successful push persists and reports googleAdsUpdated (single push)', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ ok: true });

      const result = await BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true });

      expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
      expect(mockCampaignUpdate).toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(true);
      expect(result.livePushAttempted).toBe(true);
    });

    test('unlinked campaign: requireLivePush is a no-op, DB-only intent persists', async () => {
      campaignFirstRow = { ...baseCampaign(), platform_campaign_id: null };
      mockIsConfigured.mockReturnValue(true);

      const result = await BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true });

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).toHaveBeenCalled();
      expect(result.googleAdsUpdated).toBe(false);
    });

    test('persist failure AFTER a successful push rolls the live budget back', async () => {
      campaignFirstRow = baseCampaign(); // current '40'
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ ok: true }); // push + rollback both accepted
      mockCampaignUpdate.mockRejectedValueOnce(new Error('db down'));

      await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_rolled_back' });

      // First call pushed the new amount; second restored the prior current.
      expect(mockUpdateBudget).toHaveBeenCalledTimes(2);
      expect(mockUpdateBudget).toHaveBeenLastCalledWith('1234567890', 40);
      expect(mockLogInsert).not.toHaveBeenCalled();
    });

    test('persist failure with a failed rollback reports live_push_ambiguous', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget
        .mockResolvedValueOnce({ ok: true })  // push accepted
        .mockResolvedValueOnce(null);         // rollback refused
      mockCampaignUpdate.mockRejectedValueOnce(new Error('db down'));

      await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
        .rejects.toMatchObject({ code: 'live_push_ambiguous' });
    });

    test('setBudget requireBaseMode: a throttled row re-read inside the call throws mode_conflict before any push', async () => {
      campaignFirstRow = { ...baseCampaign(), budget_mode: 'spent' };
      mockIsConfigured.mockReturnValue(true);

      await expect(BudgetManager.setBudget('c-1', 50, 'test', { requireLivePush: true, requireBaseMode: true }))
        .rejects.toMatchObject({ code: 'mode_conflict' });

      expect(mockUpdateBudget).not.toHaveBeenCalled();
      expect(mockCampaignUpdate).not.toHaveBeenCalled();
    });

    test('opts.trigger lands in the ad_budget_log row', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ ok: true });

      await BudgetManager.setBudget('c-1', 50, 'test', { requireLivePush: true, requireBaseMode: true, trigger: 'advisor' });

      expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'advisor' }));
    });

    test('rounds the base to cents so Google and the DB agree', async () => {
      campaignFirstRow = baseCampaign();
      mockIsConfigured.mockReturnValue(true);
      mockUpdateBudget.mockResolvedValue({ success: true });

      const result = await BudgetManager.setBudget('c-1', 50.007, 'test', { requireLivePush: true }); // -> 50.01

      expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 50.01);
      expect(mockCampaignUpdate).toHaveBeenCalledWith({
        daily_budget_base: 50.01,
        daily_budget_current: 50.01,
        updated_at: expect.any(Date),
      });
      expect(result.newBudget).toBe(50.01);
    });
  });
});


// r7: in-lock rechecks + cron serialization
describe('in-lock rechecks (requireLivePush)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    campaignRows = [];
    campaignFirstRow = null;
    mockNewerAuditRow = null;
    mockOwnOpRow = null;
  });

  test('setMode: applying the already-current mode throws mode_noop before any push', async () => {
    campaignFirstRow = { ...baseCampaign(), budget_mode: 'stop' };
    mockIsConfigured.mockReturnValue(true);

    await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
      .rejects.toMatchObject({ code: 'mode_noop' });

    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
  });

  test('setBudget requireBoundFactor: out-of-bounds against the LOCKED base throws before any push', async () => {
    campaignFirstRow = baseCampaign(); // base 40
    mockIsConfigured.mockReturnValue(true);

    await expect(BudgetManager.setBudget('c-1', 3000, 'test', { requireLivePush: true, requireBoundFactor: 3 }))
      .rejects.toMatchObject({ code: 'budget_out_of_bounds' });

    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
  });

  test('setBudget requireBoundFactor: target == locked base == current throws budget_noop', async () => {
    campaignFirstRow = baseCampaign(); // base 40, current 40 (strings parse to 40)
    mockIsConfigured.mockReturnValue(true);

    await expect(BudgetManager.setBudget('c-1', 40, 'test', { requireLivePush: true, requireBoundFactor: 3 }))
      .rejects.toMatchObject({ code: 'budget_noop' });

    expect(mockUpdateBudget).not.toHaveBeenCalled();
  });

  test('setBudget requireBoundFactor: no recorded budget at all throws budget_unbounded', async () => {
    campaignFirstRow = { ...baseCampaign(), daily_budget_base: null, daily_budget_current: null };
    mockIsConfigured.mockReturnValue(true);

    await expect(BudgetManager.setBudget('c-1', 30, 'test', { requireLivePush: true, requireBoundFactor: 3 }))
      .rejects.toMatchObject({ code: 'budget_unbounded' });
  });

  test('commit failure after a successful push still takes the compensating rollback', async () => {
    campaignFirstRow = baseCampaign();
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true }); // push + rollback accepted
    // Statements succeed; the APPLY transaction's own COMMIT rejects. The
    // rollback's reacquire-transaction (second call) must still work.
    const realTransaction = mockDb.transaction;
    let firstTrx = true;
    mockDb.transaction = async (cb) => {
      const r = await cb(mockDb);
      if (firstTrx) { firstTrx = false; throw new Error('commit failed'); }
      return r;
    };

    await expect(BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true }))
      .rejects.toMatchObject({ code: 'live_push_rolled_back' });

    mockDb.transaction = realTransaction;
  });

  test('cron adjustBudgets re-reads the row under the lock and skips a just-paused campaign', async () => {
    // List read returns an active row; the locked re-read sees it paused.
    campaignRows = [baseCampaign()];
    campaignFirstRow = { ...baseCampaign(), status: 'paused' };
    mockIsEnabled.mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
    jest.spyOn(BudgetManager, 'getCapacityForArea')
      .mockResolvedValue({ utilizationPct: 99, booked: 8, slots: 8, techs: 1 });

    await BudgetManager.adjustBudgets();

    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('rollback is skipped when a newer state committed meanwhile (superseded)', async () => {
    // Snapshot says base/$40; the locked re-read shows a newer committed $55.
    campaignFirstRow = { ...baseCampaign(), daily_budget_current: '55' };
    mockIsConfigured.mockReturnValue(true);

    const err = await BudgetManager.rollbackAfterLivePush(baseCampaign(), new Error('db down'));

    expect(err.code).toBe('live_push_rolled_back');
    expect(err.message).toMatch(/newer budget change/);
    expect(mockUpdateBudget).not.toHaveBeenCalled();
  });

  test('cron transition: persist failure after a successful push compensates Google', async () => {
    campaignRows = [baseCampaign()];
    mockIsEnabled.mockReturnValue(true);
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });
    mockLogInsert.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(BudgetManager, 'getCapacityForArea')
      .mockResolvedValue({ utilizationPct: 99, booked: 8, slots: 8, techs: 1 });

    await BudgetManager.adjustBudgets(); // must not throw — cron continues

    // 1st push = the stop transition (0.4); 2nd = the compensating rollback
    // to the prior live amount after the transaction failed.
    expect(mockUpdateBudget).toHaveBeenCalledTimes(2);
    expect(mockUpdateBudget).toHaveBeenLastCalledWith('1234567890', 40);
    jest.restoreAllMocks();
  });
});
// r9: sync-mirror detection + gate-aware ambiguity
describe('rollbackAfterLivePush r9', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    campaignRows = [];
    campaignFirstRow = null;
    mockNewerAuditRow = null;
    mockOwnOpRow = null;
  });

  test('a sync mirror of OUR failed push is restored, not treated as superseded', async () => {
    // Snapshot: base mode, current $40. The daily sync mirrored our failed
    // push's live amount (0.4) into current — mode untouched.
    campaignFirstRow = { ...baseCampaign(), daily_budget_current: '0.4' };
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });

    const err = await BudgetManager.rollbackAfterLivePush(baseCampaign(), new Error('db down'), 0.4);

    expect(err.code).toBe('live_push_rolled_back');
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 40);
    // The mirrored current is corrected back too.
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 40, updated_at: expect.any(Date) });
  });

  test('ambiguous outcome with the live-push gate OFF says it will not self-heal', async () => {
    mockIsEnabled.mockReturnValue(false);
    // NULL prior current → no safe restore possible → ambiguous.
    const err = await BudgetManager.rollbackAfterLivePush(
      { ...baseCampaign(), daily_budget_current: null }, new Error('db down'), 30);

    expect(err.code).toBe('live_push_ambiguous');
    expect(err.message).toMatch(/will NOT self-heal/);
  });

  test('ambiguous outcome with the gate ON still promises the reconcile', async () => {
    mockIsEnabled.mockReturnValue(true);
    const err = await BudgetManager.rollbackAfterLivePush(
      { ...baseCampaign(), daily_budget_current: null }, new Error('db down'), 30);

    expect(err.code).toBe('live_push_ambiguous');
    // The 2-hourly reconcile can't see this drift class (current still equals
    // the mode's expected amount) — only the daily sync exposes it.
    expect(err.message).toMatch(/daily Google Ads sync/);
  });

  test('a same-amount edit that also rewrote the BASE is superseded, not treated as a mirror', async () => {
    // Advisor push $40→$50 failed to persist; a queued manual setBudget to
    // $50 then committed (base 50, current 50). Restoring $40 would clobber
    // the newer human change.
    campaignFirstRow = { ...baseCampaign(), daily_budget_base: '50', daily_budget_current: '50' };
    mockIsConfigured.mockReturnValue(true);

    const err = await BudgetManager.rollbackAfterLivePush(baseCampaign(), new Error('db down'), 50);

    expect(err.code).toBe('live_push_rolled_back');
    expect(err.message).toMatch(/newer budget change/);
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
  });

  test('manual (legacy) setMode: commit failure after an accepted push takes the compensating rollback', async () => {
    campaignFirstRow = baseCampaign();
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });
    const realTransaction = mockDb.transaction;
    let firstTrx = true;
    mockDb.transaction = async (cb) => {
      const r = await cb(mockDb);
      if (firstTrx) { firstTrx = false; throw new Error('commit failed'); }
      return r;
    };

    await expect(BudgetManager.setMode('c-1', 'stop', 'test'))
      .rejects.toMatchObject({ code: 'live_push_rolled_back' });

    // Push (0.4) then compensating restore (40).
    expect(mockUpdateBudget).toHaveBeenLastCalledWith('1234567890', 40);
    mockDb.transaction = realTransaction;
  });

  test('a newer PROVEN audit row since the lock forces superseded — even when the row looks like a mirror', async () => {
    campaignFirstRow = { ...baseCampaign(), daily_budget_current: '0.4' }; // mirror signature
    // A REAL writer committed meanwhile WITH proof it changed Google.
    mockNewerAuditRow = { id: 'log-1', google_ads_updated: true };
    mockIsConfigured.mockReturnValue(true);

    const err = await BudgetManager.rollbackAfterLivePush(baseCampaign(), new Error('db down'), 0.4, new Date('2026-07-17T01:00:00Z'));

    expect(err.code).toBe('live_push_rolled_back');
    expect(err.message).toMatch(/newer budget change/);
    expect(mockUpdateBudget).not.toHaveBeenCalled();
  });

  test('a newer LOCAL-ONLY writer (no Google proof) does NOT suppress the restore', async () => {
    // Our advisor push ($40 → $0.40) succeeded on Google but failed to
    // persist; a queued manual setMode then committed a local-only change
    // (its own push was refused — google_ads_updated:false). Google still
    // runs OUR failed amount, so the compensating restore must fire; the
    // newer local intent is left for the reconcile to converge onto.
    campaignFirstRow = { ...baseCampaign(), budget_mode: 'spent' }; // local state moved on
    mockNewerAuditRow = { id: 'log-2', google_ads_updated: false };
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });

    const err = await BudgetManager.rollbackAfterLivePush(baseCampaign(), new Error('db down'), 0.4, new Date('2026-07-17T01:00:00Z'));

    expect(err.code).toBe('live_push_rolled_back');
    expect(err.message).toMatch(/rolled back|nothing was changed/);
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 40);
    // Only updated_at is bumped — the newer writer's local intent is preserved.
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ updated_at: expect.any(Date) });
  });

  test('restore targets the amount Google actually ran pre-push, not a stale local current', async () => {
    // updateBudget observed $50 live immediately before the failed push
    // (local current said $40 — stale after an Ads Manager edit). The
    // compensating restore must put back $50 and record it as current.
    campaignFirstRow = baseCampaign(); // row unchanged since snapshot
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });

    const err = await BudgetManager.rollbackAfterLivePush(
      baseCampaign(), new Error('db down'), 0.4, new Date('2026-07-17T01:00:00Z'), 'op-x', 50);

    expect(err.code).toBe('live_push_rolled_back');
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 50);
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ updated_at: expect.any(Date), daily_budget_current: 50 });
  });

  test('null-base snapshot: a sync mirror that wrote BOTH base and current is restored, base cleared back', async () => {
    // Snapshot: base null, current $40 (bound came from current). The sync
    // mirrored our failed $30 push into base AND current.
    campaignFirstRow = { ...baseCampaign(), daily_budget_base: '30', daily_budget_current: '30' };
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });

    const snapshot = { ...baseCampaign(), daily_budget_base: null, daily_budget_current: '40' };
    const err = await BudgetManager.rollbackAfterLivePush(snapshot, new Error('db down'), 30, new Date('2026-07-17T01:00:00Z'));

    expect(err.code).toBe('live_push_rolled_back');
    expect(err.message).toMatch(/rolled back/);
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 40);
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ daily_budget_current: 40, updated_at: expect.any(Date), daily_budget_base: null });
  });

  test('manual (legacy) setBudget: commit failure after an accepted push takes the compensating rollback', async () => {
    campaignFirstRow = baseCampaign();
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });
    const realTransaction = mockDb.transaction;
    let firstTrx = true;
    mockDb.transaction = async (cb) => {
      const r = await cb(mockDb);
      if (firstTrx) { firstTrx = false; throw new Error('commit failed'); }
      return r;
    };

    await expect(BudgetManager.setBudget('c-1', 50, 'test'))
      .rejects.toMatchObject({ code: 'live_push_rolled_back' });

    expect(mockUpdateBudget).toHaveBeenLastCalledWith('1234567890', 40);
    mockDb.transaction = realTransaction;
  });

  test('oversized reasons are bounded to 255 chars at the manager, covering the manual routes', async () => {
    campaignFirstRow = baseCampaign();
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });

    await BudgetManager.setMode('c-1', 'stop', 'z'.repeat(600));

    const inserted = mockLogInsert.mock.calls[0][0];
    expect(inserted.reason.length).toBeLessThanOrEqual(255);
  });

  test('lost COMMIT acknowledgement: own audit row found -> the apply reports SUCCESS, no compensation', async () => {
    campaignFirstRow = baseCampaign();
    mockIsConfigured.mockReturnValue(true);
    mockUpdateBudget.mockResolvedValue({ ok: true });
    mockOwnOpRow = { id: 'own-log-row' }; // the "failed" trx actually committed
    const realTransaction = mockDb.transaction;
    let firstTrx = true;
    mockDb.transaction = async (cb) => {
      const r = await cb(mockDb);
      if (firstTrx) { firstTrx = false; throw new Error('commit ack lost'); }
      return r;
    };

    const result = await BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true });

    expect(result.newMode).toBe('stop');
    expect(result.googleAdsUpdated).toBe(true);
    // Exactly one push — the original. No compensating restore fired.
    expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
    mockDb.transaction = realTransaction;
  });

  test('lost COMMIT acknowledgement WITHOUT a live push (unlinked): durable own audit row -> SUCCESS, not an error', async () => {
    campaignFirstRow = { ...baseCampaign(), platform_campaign_id: null }; // unlinked → no push runs
    mockIsConfigured.mockReturnValue(true);
    mockOwnOpRow = { id: 'own-log-row' }; // the "failed" trx actually committed
    const realTransaction = mockDb.transaction;
    let firstTrx = true;
    mockDb.transaction = async (cb) => {
      const r = await cb(mockDb);
      if (firstTrx) { firstTrx = false; throw new Error('commit ack lost'); }
      return r;
    };

    const result = await BudgetManager.setMode('c-1', 'stop', 'test', { requireLivePush: true });

    expect(result.newMode).toBe('stop');
    expect(result.googleAdsUpdated).toBe(false);
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    mockDb.transaction = realTransaction;
  });
});