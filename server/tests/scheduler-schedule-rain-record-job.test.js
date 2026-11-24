/**
 * The schedule rain record (services/scheduling/rain-schedule-record.js) runs at 6:06, 14:06 and 15:06 ET under
 * runExclusive('schedule-rain-record'). A run with a problem fails the job_health tick and is logged, never thrown out
 * of the tick. Same mocking shape as scheduler-ads-budget-job.test.js.
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
const mockRunScheduleRainRecord = jest.fn();
jest.mock('../services/scheduling/rain-schedule-record', () => ({ runScheduleRainRecord: mockRunScheduleRainRecord }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const { initScheduledJobs } = require('../services/scheduler');

function recordTick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes('runScheduleRainRecord'));
  expect(regs).toHaveLength(1);
  expect(regs[0][0]).toBe('6 6,14,15 * * *');
  expect(regs[0][2]).toEqual({ timezone: 'America/New_York' });
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
});

test('runs once per tick under runExclusive("schedule-rain-record") and records success', async () => {
  mockRunScheduleRainRecord.mockResolvedValue({ day: '2026-11-25', kind: 'cutoff', proposals: [], scored: [], problems: [] });
  await recordTick()();
  expect(runExclusive).toHaveBeenCalledWith('schedule-rain-record', expect.any(Function));
  expect(mockRunScheduleRainRecord).toHaveBeenCalledTimes(1);
  expect(mockJobOutcomes['schedule-rain-record']).toBe('success');
});

test('a run with a problem fails the job_health tick and is logged, never thrown out of the tick', async () => {
  mockRunScheduleRainRecord.mockRejectedValue(new Error('schedule rain record: forecast unread for all 3 outdoor visit(s) on 2026-11-25'));
  await expect(recordTick()()).resolves.toBeUndefined();
  expect(mockJobOutcomes['schedule-rain-record']).toMatch(/^failed: schedule rain record: forecast unread/);
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Schedule rain record failed'));
});
