/**
 * The 2-hour ad budget cron runs under runExclusive('ads-budget-adjust') and
 * fails the job_health tick when any campaign's push or save failed. It never
 * changes which budget is pushed. Same mocking shape as scheduler-ads-sync-health.test.js.
 * The ads health alerts (services/ads/ads-health-alerts.js) run on the same 2-hour beat, at :20.
 */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
}));
const mockJobOutcomes = {};
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => {
    try {
      const out = await task();
      mockJobOutcomes[name] = 'success';
      return out;
    } catch (err) {
      mockJobOutcomes[name] = `failed: ${err.message}`;
      throw err;
    }
  }),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(),
}));
const mockAdjustBudgets = jest.fn();
jest.mock('../services/ads/budget-manager', () => ({ adjustBudgets: mockAdjustBudgets }));
const mockRunAdsHealthAlerts = jest.fn();
jest.mock('../services/ads/ads-health-alerts', () => ({ runAdsHealthAlerts: mockRunAdsHealthAlerts }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const { initScheduledJobs } = require('../services/scheduler');

function budgetTick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([e, cb]) => e === '0 */2 * * *' && cb.toString().includes('adjustBudgets'));
  expect(regs).toHaveLength(1);
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
});

test('runs adjustBudgets under runExclusive("ads-budget-adjust") and records success', async () => {
  mockAdjustBudgets.mockResolvedValue({ evaluated: 1, changed: 1, failed: 0 });
  await budgetTick()();
  expect(runExclusive).toHaveBeenCalledWith('ads-budget-adjust', expect.any(Function));
  expect(mockAdjustBudgets).toHaveBeenCalledTimes(1);
  expect(mockJobOutcomes['ads-budget-adjust']).toBe('success');
});

test('a run with a failed campaign fails the job_health tick (the tick itself logs, not throws)', async () => {
  mockAdjustBudgets.mockResolvedValue({ evaluated: 2, changed: 1, failed: 1 });
  await budgetTick()();
  expect(mockJobOutcomes['ads-budget-adjust']).toBe('failed: ad budget adjustment: 1 of 2 campaign(s) failed');
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Ad budget adjustment failed'));
});

test('a run that returns nothing (older shape) still succeeds', async () => {
  mockAdjustBudgets.mockResolvedValue(undefined);
  await budgetTick()();
  expect(mockJobOutcomes['ads-budget-adjust']).toBe('success');
});

test('a run whose gap-rule record was not saved fails the job_health tick', async () => {
  mockAdjustBudgets.mockResolvedValue({ evaluated: 1, changed: 1, failed: 0, recordFailed: true });
  await budgetTick()();
  expect(mockJobOutcomes['ads-budget-adjust']).toBe('failed: ad budget adjustment: the gap-rule record was not saved');
});

function alertsTick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([e, cb]) => e === '20 */2 * * *' && cb.toString().includes('runAdsHealthAlerts'));
  expect(regs).toHaveLength(1);
  expect(regs[0][2]).toEqual({ timezone: 'America/New_York' });
  return regs[0][1];
}

test('the ads health alerts run every 2 hours at :20 ET under runExclusive("ads-health-alerts")', async () => {
  mockRunAdsHealthAlerts.mockResolvedValue({ skipped: 'off' });
  await alertsTick()();
  expect(runExclusive).toHaveBeenCalledWith('ads-health-alerts', expect.any(Function));
  expect(mockRunAdsHealthAlerts).toHaveBeenCalledTimes(1);
  expect(mockJobOutcomes['ads-health-alerts']).toBe('success');
});

test('an ads health alert run that fails fails the job_health tick and is logged, never thrown out of the tick', async () => {
  mockRunAdsHealthAlerts.mockRejectedValue(new Error('ads health alerts: Google Ads read: synthetic'));
  await expect(alertsTick()()).resolves.toBeUndefined();
  expect(mockJobOutcomes['ads-health-alerts']).toBe('failed: ads health alerts: Google Ads read: synthetic');
  expect(logger.error).toHaveBeenCalledWith('Ads health alerts failed: ads health alerts: Google Ads read: synthetic');
});
