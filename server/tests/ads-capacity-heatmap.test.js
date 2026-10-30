/**
 * getWeeklyHeatmap feeds the PPC Capacity tab. It must show 14 ET days starting
 * today (labels from the ET date string, never a UTC weekday), one 'all' row
 * (the schedule the budget rule reads), no per-day mode, and the live campaigns
 * plus the last budget changes.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockBookedByDate = {};
let mockCampaigns = [];
let mockChanges = [];
let mockLatest = [];
let mockLatestIds = null;
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'technicians') {
    const q = { where: () => q, then: (res, rej) => Promise.resolve([{ id: 1 }]).then(res, rej) };
    return q;
  }
  if (table === 'scheduled_services') {
    let date;
    const q = {
      where: (cond) => { date = cond.scheduled_date; return q; },
      whereNotIn: () => q,
      count: () => q,
      first: () => Promise.resolve({ count: mockBookedByDate[date] || 0 }),
    };
    return q;
  }
  if (table === 'ad_campaigns') {
    const q = { where: () => q, orderBy: () => q, select: () => Promise.resolve(mockCampaigns) };
    return q;
  }
  if (table === 'ad_budget_log') {
    const q = {
      whereIn: (_col, ids) => { mockLatestIds = ids; return q; },
      distinctOn: () => q,
      orderBy: () => q,
      select: () => Promise.resolve(mockLatest),
    };
    return q;
  }
  if (table === 'ad_budget_log as l') {
    const q = { join: () => q, where: () => q, orderBy: () => q, limit: () => q, select: () => Promise.resolve(mockChanges) };
    return q;
  }
  return { first: () => Promise.resolve(null) };
}));

const BudgetManager = require('../services/ads/budget-manager');

beforeEach(() => {
  mockBookedByDate = {};
  mockCampaigns = [];
  mockChanges = [];
  mockLatest = [];
  mockLatestIds = null;
  delete process.env.GATE_ADS_CAPACITY_WORK_DAYS;
  // 8:06 PM ET on Thu Oct 29 2026 (EDT): UTC is already Friday Oct 30.
  jest.useFakeTimers({ now: new Date('2026-10-30T00:06:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
});
afterEach(() => jest.useRealTimers());

test('starts today in ET, covers 14 consecutive dates across the Nov 1 DST change', async () => {
  mockBookedByDate = { '2026-10-29': 3, '2026-11-02': 10 };
  const { heatmap } = await BudgetManager.getWeeklyHeatmap();
  const days = heatmap.all.days;

  expect(days).toHaveLength(14);
  expect(days.map((d) => d.date)).toEqual([
    '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04',
    '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11',
  ]);
  expect(days[0]).toMatchObject({ dayName: 'Thu', dayLabel: 'Oct 29', booked: 3 });
  expect(days[3]).toMatchObject({ dayName: 'Sun', dayLabel: 'Nov 1', isSunday: true, slots: 2 });
  expect(days[4]).toMatchObject({ dayName: 'Mon', dayLabel: 'Nov 2', booked: 10, slots: 8, utilizationPct: 100, colorZone: 'red' });
  expect(days[2]).toMatchObject({ dayName: 'Sat', slots: 5 });
  expect(days.filter((d) => d.isSunday).map((d) => d.date)).toEqual(['2026-11-01', '2026-11-08']);
});

test('returns one all row, no per-day budget mode, and the campaigns and recent changes', async () => {
  mockCampaigns = [{ id: 'c1', campaign_name: 'Waves Pest Control - GBP Search', budget_mode: 'stop', daily_budget_current: '0.05', daily_budget_base: '5.00' }];
  mockChanges = [{
    created_at: new Date('2026-10-27T18:00:00Z'), campaign_name: 'Waves Pest Control - GBP Search', previous_mode: 'spent', new_mode: 'stop',
    previous_budget: '5.00', new_budget: '0.05', reason: 'Capacity 100% for general on 2026-10-28', trigger: 'auto', google_ads_updated: true,
  }];
  const result = await BudgetManager.getWeeklyHeatmap();

  expect(Object.keys(result.heatmap)).toEqual(['all']);
  expect(result.heatmap.all.techs).toBe(1);
  expect(result.heatmap.all.weeklySlots).toBe(result.heatmap.all.days.reduce((s, d) => s + d.slots, 0));
  for (const day of result.heatmap.all.days) expect(day).not.toHaveProperty('budgetMode');
  expect(result.campaigns).toEqual([{ ...mockCampaigns[0], lastChange: null }]);
  expect(result.recentChanges).toEqual(mockChanges);
  expect(result.thresholds).toEqual({ green: 70, yellow: 85, orange: 95 });
});

test("each campaign's latest change comes from its own id, not the global last-10 list or its name", async () => {
  mockCampaigns = [
    { id: 'c1', campaign_name: 'Same Name', budget_mode: 'stop', daily_budget_current: '0.05', daily_budget_base: '5.00' },
    { id: 'c2', campaign_name: 'Same Name', budget_mode: 'base', daily_budget_current: '9.00', daily_budget_base: '9.00' },
  ];
  // The global list holds only c2's rows (a busy campaign); c1's last change is older.
  mockChanges = [{ campaign_id: 'c2', campaign_name: 'Same Name', new_mode: 'base' }];
  mockLatest = [{ campaign_id: 'c1', created_at: new Date('2026-10-20T18:00:00Z'), previous_mode: 'spent', new_mode: 'stop' }];
  const { campaigns } = await BudgetManager.getWeeklyHeatmap();

  expect(mockLatestIds).toEqual(['c1', 'c2']);
  expect(campaigns[0].lastChange).toMatchObject({ campaign_id: 'c1', new_mode: 'stop' });
  expect(campaigns[1].lastChange).toBeNull();
});

