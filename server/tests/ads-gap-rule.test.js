// Ads gap-fill rule (GATE_ADS_GAP_RULE): the gate reader, the pure settings /
// decision / hold helpers, the 7-day window, and adjustBudgets in off / shadow /
// live. The gate-off path is pinned by ads-budget-manager-live-push.test.js
// (unchanged); here "off" additionally proves no gap-rule table is touched.

const mockIsEnabled = jest.fn();
let mockGapMode = 'off';
jest.mock('../config/feature-gates', () => ({
  isEnabled: mockIsEnabled,
  adsGapRuleMode: () => mockGapMode,
}));

jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const mockIsConfigured = jest.fn();
const mockUpdateBudget = jest.fn();
jest.mock('../services/ads/google-ads', () => ({
  isConfigured: mockIsConfigured,
  updateBudget: mockUpdateBudget,
}));

const mockCampaignUpdate = jest.fn().mockResolvedValue(1);
const mockLogInsert = jest.fn().mockResolvedValue([]);
let campaignRows = [];
let targetsRow = {};
let stopRows = [];
let settingsStore = {};
let settingsUpserts = [];
let windowQuery = null;
const touchedTables = new Set();

const mockDb = jest.fn((table) => {
  touchedTables.add(table);
  if (table === 'ad_campaigns') {
    const builder = {
      where: jest.fn(() => builder),
      forUpdate: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(campaignRows[0] ?? null)),
      update: mockCampaignUpdate,
      then: (resolve, reject) => Promise.resolve(campaignRows).then(resolve, reject),
    };
    return builder;
  }
  if (table === 'ad_targets') return { first: jest.fn(() => Promise.resolve(targetsRow)) };
  if (table === 'ad_budget_log') {
    const b = { insert: mockLogInsert, where: jest.fn(() => b), first: jest.fn(() => Promise.resolve(null)) };
    return b;
  }
  if (table === 'scheduled_services') {
    windowQuery = { reservationClause: [] };
    const b = {
      whereBetween: jest.fn((col, range) => { windowQuery.range = range; return b; }),
      whereNotIn: jest.fn((col, list) => { windowQuery.excluded = list; return b; }),
      where: jest.fn((fn) => {
        fn.call({
          whereNull: (c) => { windowQuery.reservationClause.push(`null:${c}`); return { orWhere: (c2, op) => windowQuery.reservationClause.push(`or:${c2}${op}`) }; },
        });
        return b;
      }),
      groupBy: jest.fn(() => b),
      select: jest.fn(() => b),
      countDistinct: jest.fn((arg) => { windowQuery.distinct = arg; return b; }),
      then: (resolve, reject) => Promise.resolve(stopRows).then(resolve, reject),
    };
    return b;
  }
  if (table === 'system_settings') {
    return {
      where: jest.fn(({ key }) => ({ first: () => Promise.resolve(key in settingsStore ? { key, value: settingsStore[key] } : null) })),
      insert: jest.fn((row) => ({
        onConflict: () => ({
          merge: () => { settingsStore[row.key] = row.value; settingsUpserts.push(row); return Promise.resolve(); },
        }),
      })),
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
const { NOT_A_ROUTE_STOP_STATUSES } = require('../services/stops-ahead');

const NOW = new Date('2026-10-30T00:06:00Z'); // 8:06 PM ET Thursday Oct 29, 2026
const DEFAULTS = BudgetManager.GAP_RULE_DEFAULTS;

const campaign = (over = {}) => ({
  id: 'c-1',
  campaign_name: 'Waves Pest Control - GBP Search',
  platform: 'google_ads',
  platform_campaign_id: '1234567890',
  target_area: null,
  budget_mode: 'stop',
  daily_budget_base: '5',
  daily_budget_current: '0.05',
  status: 'active',
  metadata: null,
  ...over,
});

// n stops on each of the 7 window days (1 tech: limits 9 weekday, 8 Sat, 6 Sun).
const stopsEveryDay = (n) => ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
  .map((day) => ({ day, stops: String(n) }));

beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime'],
  });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  mockGapMode = 'off';
  campaignRows = [];
  targetsRow = {};
  stopRows = [];
  settingsStore = {};
  settingsUpserts = [];
  windowQuery = null;
  touchedTables.clear();
  mockIsEnabled.mockReturnValue(true);
  mockIsConfigured.mockReturnValue(true);
  mockUpdateBudget.mockResolvedValue({ success: true });
  jest.spyOn(BudgetManager, 'getTechCountForArea').mockResolvedValue(1);
  jest.spyOn(BudgetManager, 'getCapacityForArea').mockResolvedValue({ utilizationPct: 99 });
});
afterEach(() => jest.restoreAllMocks());

describe('adsGapRuleMode (gate reader)', () => {
  const actual = jest.requireActual('../config/feature-gates');
  const original = process.env.GATE_ADS_GAP_RULE;
  afterEach(() => {
    if (original === undefined) delete process.env.GATE_ADS_GAP_RULE;
    else process.env.GATE_ADS_GAP_RULE = original;
  });
  test.each([
    [undefined, 'off'],
    ['', 'off'],
    ['shadow', 'shadow'],
    [' Shadow ', 'shadow'],
    ['true', 'live'],
    [' TRUE ', 'live'],
    ['false', 'off'],
    ['live', 'off'],
    ['1', 'off'],
  ])('GATE_ADS_GAP_RULE=%j reads %s', (value, expected) => {
    if (value === undefined) delete process.env.GATE_ADS_GAP_RULE;
    else process.env.GATE_ADS_GAP_RULE = value;
    expect(actual.adsGapRuleMode()).toBe(expected);
  });
});

describe('settings reader', () => {
  test('no metadata gives every default', () => {
    expect(BudgetManager.normalizeGapSettings(null)).toEqual(DEFAULTS);
    expect(BudgetManager.normalizeGapSettings({ other: 1 })).toEqual(DEFAULTS);
  });

  test('each invalid field falls back by itself; valid fields stay', () => {
    const out = BudgetManager.normalizeGapSettings({
      gap_rule: { weekday_limit: 31, saturday_limit: '8', sunday_limit: 5, window_days: 0, run_at_open: 201, stop_below_open: 1.5 },
    });
    expect(out).toEqual({ ...DEFAULTS, sunday_limit: 5 });
  });

  test('reads metadata stored as a JSON string', () => {
    expect(BudgetManager.normalizeGapSettings(JSON.stringify({ gap_rule: { run_at_open: 10, stop_below_open: 4 } })))
      .toEqual({ ...DEFAULTS, run_at_open: 10, stop_below_open: 4 });
  });

  test('stop_below_open above run_at_open falls back, capped at run_at_open', () => {
    expect(BudgetManager.normalizeGapSettings({ gap_rule: { run_at_open: 8, stop_below_open: 9 } }).stop_below_open).toBe(3);
    expect(BudgetManager.normalizeGapSettings({ gap_rule: { run_at_open: 2, stop_below_open: 9 } }).stop_below_open).toBe(2);
  });

  test('a PUT patch is validated per field and as a pair', () => {
    expect(BudgetManager.validateGapSettingsPatch({ window_days: 15 }, DEFAULTS))
      .toEqual({ ok: false, error: 'window_days must be a whole number from 1 to 14.' });
    expect(BudgetManager.validateGapSettingsPatch({ nope: 1 }, DEFAULTS).ok).toBe(false);
    expect(BudgetManager.validateGapSettingsPatch({}, DEFAULTS).ok).toBe(false);
    expect(BudgetManager.validateGapSettingsPatch({ stop_below_open: 7 }, DEFAULTS).error).toMatch(/stop_below_open/);
    const ok = BudgetManager.validateGapSettingsPatch({ run_at_open: 12, stop_below_open: 5 }, DEFAULTS);
    expect(ok).toEqual({ ok: true, patch: { run_at_open: 12, stop_below_open: 5 }, merged: { ...DEFAULTS, run_at_open: 12, stop_below_open: 5 } });
  });
});

describe('decision table', () => {
  const s = DEFAULTS; // run at >= 6, stop below 3
  test.each([
    [6, 'stop', 'base'],
    [30, 'base', 'base'],
    [2, 'base', 'stop'],
    [0, 'spent', 'stop'],
  ])('%i open with a %s campaign -> %s', (open, state, expected) => {
    expect(BudgetManager.decideGapMode(open, s, { budget_mode: state, daily_budget_current: '5', daily_budget_base: '5' })).toBe(expected);
  });

  test('between the thresholds a campaign keeps its state', () => {
    const c = (budget_mode, cur) => ({ budget_mode, daily_budget_current: cur, daily_budget_base: '5' });
    expect(BudgetManager.decideGapMode(3, s, c('base', '5'))).toBe('base');
    expect(BudgetManager.decideGapMode(5, s, c('stop', '0.05'))).toBe('stop');
  });

  test("'spent' between the thresholds maps by its budget and never stays 'spent'", () => {
    const spent = (cur) => ({ budget_mode: 'spent', daily_budget_current: cur, daily_budget_base: '5' });
    expect(BudgetManager.decideGapMode(4, s, spent('0.05'))).toBe('stop');
    expect(BudgetManager.decideGapMode(4, s, spent('3.2'))).toBe('stop');
    expect(BudgetManager.decideGapMode(4, s, spent('5'))).toBe('base');
  });

  test('gapBand names the middle band keep', () => {
    expect(BudgetManager.gapBand(4, s)).toBe('keep');
  });
});

describe('hold reader', () => {
  const hold = (over) => ({ budget_hold: { mode: 'base', until: '2026-10-30', ...over } });
  test('active through its end date, ignored after, ignored when malformed', () => {
    expect(BudgetManager.activeBudgetHold(hold(), '2026-10-30')).toMatchObject({ mode: 'base' });
    expect(BudgetManager.activeBudgetHold(hold(), '2026-10-31')).toBeNull();
    expect(BudgetManager.activeBudgetHold(hold({ mode: 'spent' }), '2026-10-29')).toBeNull();
    expect(BudgetManager.activeBudgetHold(hold({ until: 'soon' }), '2026-10-29')).toBeNull();
    expect(BudgetManager.activeBudgetHold(null, '2026-10-29')).toBeNull();
    expect(BudgetManager.activeBudgetHold(JSON.stringify(hold()), '2026-10-29')).toMatchObject({ until: '2026-10-30' });
  });
});

describe('getGapWindow', () => {
  test('is the 7 ET dates starting tomorrow, across the Nov 1 DST change', async () => {
    const win = await BudgetManager.getGapWindow(NOW, DEFAULTS);
    expect(win.days.map((d) => d.date)).toEqual([
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
    ]);
    expect(win.window_start).toBe('2026-10-30');
    expect(win.window_end).toBe('2026-11-05');
  });

  test('Saturday and Sunday use their own limits; open never goes below 0', async () => {
    stopRows = [{ day: '2026-10-30', stops: '4' }, { day: '2026-10-31', stops: '10' }, { day: '2026-11-01', stops: '2' }];
    const win = await BudgetManager.getGapWindow(NOW, DEFAULTS);
    const by = Object.fromEntries(win.days.map((d) => [d.date, d]));
    expect(by['2026-10-30']).toMatchObject({ stops: 4, techs: 1, limit: 9, open: 5 }); // Friday
    expect(by['2026-10-31']).toMatchObject({ stops: 10, limit: 8, open: 0 }); // Saturday, over the limit
    expect(by['2026-11-01']).toMatchObject({ stops: 2, limit: 6, open: 4 }); // Sunday
    expect(by['2026-11-02']).toMatchObject({ stops: 0, limit: 9, open: 9 });
    expect(win.total_stops).toBe(16);
    expect(win.total_limit).toBe(9 + 8 + 6 + 9 * 4);
    expect(win.total_open).toBe(5 + 0 + 4 + 36);
  });

  test('limit scales by the technician count of each date', async () => {
    BudgetManager.getTechCountForArea.mockImplementation(async (_a, date) => (date === '2026-11-02' ? 0 : 2));
    const win = await BudgetManager.getGapWindow(NOW, DEFAULTS);
    expect(win.days.find((d) => d.date === '2026-11-02').limit).toBe(0);
    expect(win.days.find((d) => d.date === '2026-10-30').limit).toBe(18);
    expect(BudgetManager.getTechCountForArea).toHaveBeenCalledWith('general', '2026-10-30');
  });

  test('uses ONE grouped query that counts distinct customers on live route stops', async () => {
    await BudgetManager.getGapWindow(NOW, DEFAULTS);
    expect(mockDb.mock.calls.filter(([t]) => t === 'scheduled_services')).toHaveLength(1);
    expect(windowQuery.range).toEqual(['2026-10-30', '2026-11-05']);
    expect(windowQuery.excluded).toEqual(NOT_A_ROUTE_STOP_STATUSES);
    expect(windowQuery.distinct).toBe('customer_id as stops');
    expect(windowQuery.reservationClause).toEqual(['null:reservation_expires_at', 'or:reservation_expires_at>']);
  });

  test('window_days shortens the window', async () => {
    const win = await BudgetManager.getGapWindow(NOW, { ...DEFAULTS, window_days: 3 });
    expect(win.days.map((d) => d.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('adjustBudgets: gate off', () => {
  test('the old rule acts and no gap-rule table is read or written', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5', metadata: { budget_hold: { mode: 'base', until: '2026-12-01' } } })];
    const out = await BudgetManager.adjustBudgets();
    // 99% utilization -> stop; the hold is ignored while off.
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.05);
    expect(touchedTables.has('scheduled_services')).toBe(false);
    expect(touchedTables.has('system_settings')).toBe(false);
    expect(out).toEqual({ evaluated: 1, changed: 1, failed: 0 });
  });
});

describe('adjustBudgets: shadow', () => {
  beforeEach(() => { mockGapMode = 'shadow'; });

  test('the old rule still decides and pushes; the gap rule only writes a record', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5' })];
    stopRows = stopsEveryDay(0); // gap rule would say base (63 open)
    const out = await BudgetManager.adjustBudgets();

    expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.05); // old rule: stop
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({ new_mode: 'stop', reason: expect.stringContaining('Capacity') }));
    expect(out).toEqual({ evaluated: 1, changed: 1, failed: 0 });

    const last = JSON.parse(settingsStore['ads.gap_rule.last']);
    expect(last).toMatchObject({
      mode: 'shadow',
      window_start: '2026-10-30',
      window_end: '2026-11-05',
      total_open: 9 * 5 + 8 + 6,
      decision: 'base',
      campaigns: [{ id: 'c-1', old_rule_mode: 'stop' }],
    });
    expect(last.days).toHaveLength(7);
    const history = JSON.parse(settingsStore['ads.gap_rule.history']);
    expect(history).toEqual([{ at: NOW.toISOString(), mode: 'shadow', total_open: 59, decision: 'base' }]);
    expect(logger.info).toHaveBeenCalledWith('[ads-gap-rule shadow] open 59 in 2026-10-30..2026-11-05 -> base');
  });

  test('history keeps the last 120 entries', async () => {
    campaignRows = [];
    settingsStore['ads.gap_rule.history'] = JSON.stringify(Array.from({ length: 125 }, (_, i) => ({ at: `t${i}`, mode: 'shadow', total_open: i, decision: 'keep' })));
    await BudgetManager.adjustBudgets();
    const history = JSON.parse(settingsStore['ads.gap_rule.history']);
    expect(history).toHaveLength(120);
    expect(history[119].at).toBe(NOW.toISOString());
    expect(history[0].at).toBe('t6');
  });

  test('a hold overrides the old rule', async () => {
    campaignRows = [campaign({ budget_mode: 'stop', daily_budget_current: '0.05', metadata: { budget_hold: { mode: 'base', until: '2026-10-30' } } })];
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 5);
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({ new_mode: 'base', reason: 'Hold: base until 2026-10-30 (set in the portal)' }));
    expect(JSON.parse(settingsStore['ads.gap_rule.last']).campaigns).toEqual([{ id: 'c-1', old_rule_mode: 'stop' }]);
  });

  test('an expired hold is ignored (a hold ending today still counts)', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5', metadata: { budget_hold: { mode: 'base', until: '2026-10-28' } } })];
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.05); // old rule: stop
  });

  test('a failed record write does not fail the budget run', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5' })];
    BudgetManager.getTechCountForArea.mockRejectedValue(new Error('tech query down'));
    const out = await BudgetManager.adjustBudgets();
    expect(out).toEqual({ evaluated: 1, changed: 1, failed: 0 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not record the decision'));
  });
});

describe('adjustBudgets: live', () => {
  beforeEach(() => { mockGapMode = 'live'; });

  test('plenty of open stops: a stopped campaign goes to base, pushed first', async () => {
    campaignRows = [campaign()];
    stopRows = stopsEveryDay(0);
    const out = await BudgetManager.adjustBudgets();

    expect(BudgetManager.getCapacityForArea).not.toHaveBeenCalled();
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 5);
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ budget_mode: 'base', daily_budget_current: 5, updated_at: expect.any(Date) });
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      previous_mode: 'stop',
      new_mode: 'base',
      reason: 'Gap rule: 59 open stops 2026-10-30..2026-11-05 (run at ≥6, stop below 3)',
      trigger: 'auto',
      capacity_pct: 0,
      check_date: '2026-10-30',
      google_ads_updated: true,
    }));
    expect(out).toEqual({ evaluated: 1, changed: 1, failed: 0 });
    expect(JSON.parse(settingsStore['ads.gap_rule.last'])).toMatchObject({ mode: 'live', decision: 'base', total_open: 59 });
    expect(JSON.parse(settingsStore['ads.gap_rule.history'])).toHaveLength(1);
  });

  test('few open stops: a base campaign drops to the 1% floor and capacity_pct is the booked share', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5' })];
    stopRows = [{ day: '2026-10-30', stops: '9' }, { day: '2026-10-31', stops: '8' }, { day: '2026-11-01', stops: '6' }, { day: '2026-11-02', stops: '8' }, { day: '2026-11-03', stops: '9' }, { day: '2026-11-04', stops: '9' }, { day: '2026-11-05', stops: '9' }];
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.05);
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      new_mode: 'stop',
      reason: 'Gap rule: 1 open stops 2026-10-30..2026-11-05 (run at ≥6, stop below 3)',
      capacity_pct: 98,
    }));
  });

  test("'spent' frozen at the stop amount goes to 'stop' with no push, logged as not pushed", async () => {
    campaignRows = [campaign({ budget_mode: 'spent', daily_budget_current: '0.05' })];
    stopRows = stopsEveryDay(9);
    const out = await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).toHaveBeenCalledWith({ budget_mode: 'stop', daily_budget_current: 0.05, updated_at: expect.any(Date) });
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({
      new_mode: 'stop',
      google_ads_updated: false,
      reason: expect.stringContaining('no push needed'),
    }));
    expect(out.changed).toBe(1);
  });

  test('between the thresholds a campaign at its state is left alone (no write, no push)', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5' })];
    stopRows = [{ day: '2026-10-30', stops: '9' }, { day: '2026-10-31', stops: '8' }, { day: '2026-11-01', stops: '6' }, { day: '2026-11-02', stops: '9' }, { day: '2026-11-03', stops: '9' }, { day: '2026-11-04', stops: '7' }, { day: '2026-11-05', stops: '7' }];
    const out = await BudgetManager.adjustBudgets(); // open = 0+0+0+0+0+2+2 = 4, inside the 3..5 keep band
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
    expect(mockLogInsert).not.toHaveBeenCalled();
    expect(out).toEqual({ evaluated: 1, changed: 0, failed: 0 });
    expect(JSON.parse(settingsStore['ads.gap_rule.last']).decision).toBe('keep');
  });

  test('a hold overrides the gap decision and logs the hold reason', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5', metadata: { budget_hold: { mode: 'stop', until: '2026-11-02' } } })];
    stopRows = stopsEveryDay(0);
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).toHaveBeenCalledWith('1234567890', 0.05);
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({ new_mode: 'stop', reason: 'Hold: stop until 2026-11-02 (set in the portal)' }));
  });

  test('an expired hold is ignored (a hold ending today still counts)', async () => {
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5', metadata: { budget_hold: { mode: 'stop', until: '2026-10-28' } } })];
    stopRows = stopsEveryDay(0);
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).not.toHaveBeenCalled(); // already base, gap says base
    expect(mockLogInsert).not.toHaveBeenCalled();
  });

  test('settings stored on ad_targets drive the thresholds', async () => {
    targetsRow = { metadata: { gap_rule: { run_at_open: 70, stop_below_open: 50 } } };
    campaignRows = [campaign({ budget_mode: 'base', daily_budget_current: '5' })];
    stopRows = stopsEveryDay(0); // 59 open: below 70 and not below 50 -> keep
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(JSON.parse(settingsStore['ads.gap_rule.last']).decision).toBe('keep');
  });

  test('push refused: nothing saved, counted as failed', async () => {
    campaignRows = [campaign()];
    stopRows = stopsEveryDay(0);
    mockUpdateBudget.mockResolvedValue(false);
    const out = await BudgetManager.adjustBudgets();
    expect(mockCampaignUpdate).not.toHaveBeenCalled();
    expect(mockLogInsert).not.toHaveBeenCalled();
    expect(out).toEqual({ evaluated: 1, changed: 0, failed: 1 });
  });

  test('gate GATE_ADS_BUDGET_LIVE_PUSH off: local record only, as the old rule does', async () => {
    mockIsEnabled.mockReturnValue(false);
    campaignRows = [campaign()];
    stopRows = stopsEveryDay(0);
    await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(mockLogInsert).toHaveBeenCalledWith(expect.objectContaining({ new_mode: 'base', google_ads_updated: false }));
  });

  test('persist failure after a live push triggers the existing rollback and counts as failed', async () => {
    campaignRows = [campaign()];
    stopRows = stopsEveryDay(0);
    mockLogInsert.mockRejectedValueOnce(new Error('insert failed'));
    const rollback = jest.spyOn(BudgetManager, 'rollbackAfterLivePush').mockResolvedValue(new Error('rolled back'));
    const out = await BudgetManager.adjustBudgets();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ evaluated: 1, changed: 0, failed: 1 });
  });

  test('no window means no budget change: every campaign counts as failed', async () => {
    campaignRows = [campaign()];
    BudgetManager.getTechCountForArea.mockRejectedValue(new Error('tech query down'));
    const out = await BudgetManager.adjustBudgets();
    expect(mockUpdateBudget).not.toHaveBeenCalled();
    expect(out).toEqual({ evaluated: 1, changed: 0, failed: 1 });
  });
});
