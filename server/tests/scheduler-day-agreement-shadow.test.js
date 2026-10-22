/**
 * The day-agreement shadow cron: dark with the gate off (no lock, no sweep), a
 * clean sweep is a successful run, and an INCOMPLETE sweep (a model outage or a
 * source that failed) is a failed run in job health, with counts only in the log.
 * Same mocking shape as scheduler-access-codes-health.test.js.
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
const mockGates = { cronJobs: true, dayAgreementShadow: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => !!mockGates[name]), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  neighborhoodAccessLive: jest.fn(() => false),
}));
// Mirrors runExclusive's contract: the body's failure is recorded for job health, then rethrown.
const mockHealth = [];
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => {
    try {
      const out = await task();
      mockHealth.push([name, 'ok']);
      return out;
    } catch (err) {
      mockHealth.push([name, 'failed', err.code]);
      throw err;
    }
  }),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(async () => {}),
}));
jest.mock('../services/day-agreement-shadow', () => ({ runDayAgreementShadow: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { runExclusive } = require('../utils/cron-lock');
const { runDayAgreementShadow } = require('../services/day-agreement-shadow');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes("runExclusive('day-agreement-shadow'"));
  expect(regs).toHaveLength(1);
  expect(regs[0][0]).toBe('*/10 * * * *');
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHealth.length = 0;
  mockGates.dayAgreementShadow = true;
  runDayAgreementShadow.mockResolvedValue({ judged: 2, would_book: 1, would_move: 0, skip: 1, errors: 0, transient: 0 });
});

test('gate off: no lock, no sweep, no job-health row', async () => {
  mockGates.dayAgreementShadow = false;
  await tick()();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(runDayAgreementShadow).not.toHaveBeenCalled();
});

test('a complete sweep logs its counts and is a successful run', async () => {
  await tick()();
  expect(mockHealth).toEqual([['day-agreement-shadow', 'ok']]);
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"judged":2'));
  expect(logger.error).not.toHaveBeenCalled();
});

test.each([
  [{ judged: 1, errors: 1, transient: 0 }],
  [{ judged: 0, errors: 0, transient: 1 }],
  [{ judged: 3, errors: 2, transient: 1 }],
])('an incomplete sweep %j is a failed run in job health, still logged, and never escapes the tick', async (result) => {
  runDayAgreementShadow.mockResolvedValue(result);
  await expect(tick()()).resolves.toBeUndefined();
  expect(mockHealth).toEqual([['day-agreement-shadow', 'failed', 'SWEEP_INCOMPLETE']]);
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[day-agreement] sweep:'));
  expect(logger.error).toHaveBeenCalledWith('[day-agreement] sweep tick failed (SWEEP_INCOMPLETE)');
});

test('a sweep that throws is a failed run too, logged by code only', async () => {
  runDayAgreementShadow.mockRejectedValue(Object.assign(new Error('secret detail'), { code: 'ECONNRESET' }));
  await tick()();
  expect(mockHealth).toEqual([['day-agreement-shadow', 'failed', 'ECONNRESET']]);
  expect(logger.error).toHaveBeenCalledWith('[day-agreement] sweep tick failed (ECONNRESET)');
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret detail');
});
