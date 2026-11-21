// Route fill record inside the 2-hour budget run (BudgetManager.adjustBudgets -> recordRouteFill). The record is
// taken once per run, before the gap window is read. It decides no budget: a campaign marked with a route line is
// still decided by the gap rule. A problem in the record reaches the result as routeFailed and never stops a budget.
// Same harness as ads-gap-rule.test.js.

const mockIsEnabled = jest.fn();
let mockGapMode = 'live';
jest.mock('../config/feature-gates', () => ({ isEnabled: mockIsEnabled, adsGapRuleMode: () => mockGapMode }));

jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const mockUpdateBudget = jest.fn();
jest.mock('../services/ads/google-ads', () => ({ isConfigured: () => true, updateBudget: mockUpdateBudget }));

const mockRecordRun = jest.fn();
jest.mock('../services/ads/route-fill', () => ({ recordRun: mockRecordRun }));

const mockCampaignUpdate = jest.fn().mockResolvedValue(1);
const mockLogInsert = jest.fn().mockResolvedValue([]);
let campaignRows = [];
let stopRows = [];
let settingsStore = {};

const mockDb = jest.fn((table) => {
  if (table === 'ad_campaigns') {
    let id = null;
    const builder = {
      where: jest.fn((arg) => { if (arg && typeof arg === 'object' && arg.id) id = arg.id; return builder; }),
      forUpdate: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(campaignRows.find((c) => c.id === id) ?? null)),
      update: (patch) => mockCampaignUpdate(id, patch),
      then: (resolve, reject) => Promise.resolve(campaignRows).then(resolve, reject),
    };
    return builder;
  }
  if (table === 'ad_targets') return { first: jest.fn(() => Promise.resolve({})) };
  if (table === 'ad_budget_log') {
    const b = { insert: mockLogInsert, where: jest.fn(() => b), first: jest.fn(() => Promise.resolve(null)) };
    return b;
  }
  if (table === 'scheduled_services') {
    const b = {
      whereBetween: jest.fn(() => b),
      whereNotIn: jest.fn(() => b),
      where: jest.fn(() => b),
      groupBy: jest.fn(() => b),
      select: jest.fn(() => b),
      then: (resolve, reject) => Promise.resolve(stopRows).then(resolve, reject),
    };
    return b;
  }
  if (table === 'system_settings') {
    return {
      where: jest.fn(({ key }) => ({ first: () => Promise.resolve(key in settingsStore ? { key, value: settingsStore[key] } : null) })),
      insert: jest.fn((row) => ({ onConflict: () => ({ merge: () => { settingsStore[row.key] = row.value; return Promise.resolve(); } }) })),
    };
  }
  throw new Error(`Unexpected table in test: ${table}`);
});
mockDb.transaction = (cb) => cb(mockDb);
mockDb.fn = { now: () => 'NOW()' };
mockDb.raw = jest.fn((sql) => sql);
jest.mock('../models/db', () => mockDb);

const logger = require('../services/logger');
const BudgetManager = require('../services/ads/budget-manager');

const NOW = new Date('2026-10-30T00:06:00Z'); // 8:06 PM ET Thursday Oct 29, 2026

// An active Search campaign that is marked with a route line.
const fill = (over = {}) => ({
  id: 'c-pest',
  campaign_name: 'Waves Fill - Pest (route)',
  platform: 'google_ads',
  campaign_type: '2',
  platform_campaign_id: '24535212382',
  target_area: null,
  budget_mode: 'stop',
  daily_budget_base: '10',
  daily_budget_current: '0.10',
  status: 'active',
  metadata: { route_line: 'pest' },
  ...over,
});

// n stops on each of the 7 window days (1 tech: limits 9 weekday, 8 Sat, 6 Sun). 9 = full week, 0 = empty week.
const stopsEveryDay = (n) => ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  .map((day) => ({ day, stops: String(n) }));

const recorded = (problems = []) => ({ tick: '2026-10-29T20', campaigns: [], problems });

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'],
  });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  mockGapMode = 'live';
  campaignRows = [fill()];
  stopRows = stopsEveryDay(0); // an empty week: the gap rule says base
  settingsStore = {};
  mockIsEnabled.mockReturnValue(true);
  mockUpdateBudget.mockResolvedValue({ success: true });
  mockRecordRun.mockResolvedValue(recorded());
  jest.spyOn(BudgetManager, 'getTechCountForArea').mockResolvedValue(1);
  jest.spyOn(BudgetManager, 'getCapacityForArea').mockResolvedValue({ utilizationPct: 99 });
});
afterEach(() => jest.restoreAllMocks());

test('each budget run takes the record once, with the run\'s clock and the Search-only campaign filter', async () => {
  await BudgetManager.adjustBudgets();
  expect(mockRecordRun).toHaveBeenCalledTimes(1);
  const [{ now, campaignOk }] = mockRecordRun.mock.calls[0];
  expect(now).toEqual(NOW);
  expect(campaignOk({ campaign_type: '2' })).toBe(true);
  expect(campaignOk({ campaign_type: '10' })).toBe(false);
  expect(campaignOk({ campaign_type: null })).toBe(false);
});

test('the record decides no budget: a campaign marked with a route line is decided by the gap rule', async () => {
  const summary = await BudgetManager.adjustBudgets();
  expect(mockUpdateBudget.mock.calls).toEqual([['24535212382', 10]]);
  expect(mockLogInsert.mock.calls[0][0].reason).toMatch(/^Gap rule/);
  expect(summary).toEqual({ evaluated: 1, changed: 1, failed: 0 });
});

test('a record with a problem sets routeFailed and logs each problem with its tick; the budgets still move', async () => {
  mockRecordRun.mockResolvedValue(recorded(['Waves Fill - Pest (route): Google did not answer the location read', 'the run was not saved: write refused']));
  const summary = await BudgetManager.adjustBudgets();
  expect(summary).toEqual({ evaluated: 1, changed: 1, failed: 0, routeFailed: true });
  expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('[ads-route-fill] tick 2026-10-29T20: Waves Fill - Pest (route): Google did not answer the location read');
  expect(logger.error).toHaveBeenCalledWith('[ads-route-fill] tick 2026-10-29T20: the run was not saved: write refused');
});

test('a record that throws sets routeFailed and logs the cause; the budgets still move', async () => {
  mockRecordRun.mockRejectedValue(new Error('db down'));
  const summary = await BudgetManager.adjustBudgets();
  expect(summary).toEqual({ evaluated: 1, changed: 1, failed: 0, routeFailed: true });
  expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('[ads-route-fill] no record this run: db down');
});

test('the record is taken before the gap window is read, so a failed window does not skip it or hide its problem', async () => {
  const gapSpy = jest.spyOn(BudgetManager, 'evaluateGapRule').mockRejectedValue(new Error('window query failed'));
  mockRecordRun.mockResolvedValue(recorded(['the run was not saved: write refused']));
  const summary = await BudgetManager.adjustBudgets();
  expect(mockRecordRun.mock.invocationCallOrder[0]).toBeLessThan(gapSpy.mock.invocationCallOrder[0]);
  expect(mockUpdateBudget).not.toHaveBeenCalled();
  expect(summary).toEqual({ evaluated: 1, changed: 0, failed: 1, routeFailed: true });
});

test.each(['off', 'shadow'])('the record is taken with the gap rule %s too', async (mode) => {
  mockGapMode = mode;
  mockRecordRun.mockResolvedValue(recorded(['the run was not saved: write refused']));
  const summary = await BudgetManager.adjustBudgets();
  expect(mockRecordRun).toHaveBeenCalledTimes(1);
  expect(summary.routeFailed).toBe(true);
});
