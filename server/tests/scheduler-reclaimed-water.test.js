/**
 * The reclaimed-water meter cron (GATE_LAWN_RECLAIMED_HALF_N): registered once, daily 3:47am ET through the shared scheduler (a locked
 * runExclusive job, so a double fire runs the body once), does nothing while the gate is off, and reports a failed run or a missed tick
 * to job_health like its neighbours. Same mocking shape as scheduler-neighborhood-access-health.test.js.
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
const mockGate = { on: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  lawnReclaimedHalfNLive: jest.fn(() => mockGate.on),
}));
const mockJobOutcomes = {};
const mockLock = { skip: null };
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => {
    if (mockLock.skip) return { skipped: true, reason: mockLock.skip };
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
  recordMissedTick: jest.fn(async () => {}),
}));
jest.mock('../services/reclaimed-water-meters', () => ({ runDailyTick: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { recordMissedTick, runExclusive } = require('../utils/cron-lock');
const { runDailyTick } = require('../services/reclaimed-water-meters');
const { initScheduledJobs } = require('../services/scheduler');

function registration() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes('reclaimed-water-meters'));
  expect(regs).toHaveLength(1);
  return regs[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
  mockLock.skip = null;
  mockGate.on = true;
  runDailyTick.mockResolvedValue({ refreshed: 40347, checked: 12, reclaimed: 3 });
});

test('one registration, 3:47am every day, Eastern time', () => {
  const [expression, , options] = registration();
  expect(expression).toBe('47 3 * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
});

test('a clean tick records success under its own lock name', async () => {
  await registration()[1]();
  expect(runExclusive).toHaveBeenCalledWith('reclaimed-water-meters', expect.any(Function));
  expect(runDailyTick).toHaveBeenCalledTimes(1);
  expect(mockJobOutcomes['reclaimed-water-meters']).toBe('success');
});

test('the gate off: the tick takes no lock and runs nothing', async () => {
  mockGate.on = false;
  await registration()[1]();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(runDailyTick).not.toHaveBeenCalled();
});

test('a failed run (nothing usable stored, county refused) records a failed run', async () => {
  runDailyTick.mockRejectedValue(Object.assign(new Error('county layer HTTP 403'), { code: 'http_403' }));
  await registration()[1]();
  expect(mockJobOutcomes['reclaimed-water-meters']).toBe('failed: county layer HTTP 403');
});

test('a tick skipped for no connection records a missed tick; one covered by a concurrent run records nothing', async () => {
  const tick = registration()[1];
  mockLock.skip = 'no_connection';
  await tick();
  expect(recordMissedTick).toHaveBeenCalledWith('reclaimed-water-meters', expect.any(Number), 'tick skipped: no_connection');
  recordMissedTick.mockClear();
  mockLock.skip = 'lease_held';
  await tick();
  expect(recordMissedTick).not.toHaveBeenCalled();
});
