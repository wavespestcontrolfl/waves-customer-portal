/**
 * The 2-hour ad budget cron runs under runExclusive('ads-budget-adjust') and
 * fails the job_health tick when any campaign's push or save failed. It never
 * changes which budget is pushed. Same mocking shape as scheduler-ads-sync-health.test.js.
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
