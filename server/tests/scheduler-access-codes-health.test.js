/**
 * The access-codes sweep cron: dark unless GATE_ACCESS_CODES_SECTION is on, a
 * tick the cron lock skipped for lack of a connection is a missed tick in job
 * health, a tick covered by a concurrent run (lease_held) is not, and a thrown
 * sweep never escapes the tick. Same mocking shape as
 * scheduler-neighborhood-access-health.test.js.
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
  neighborhoodAccessLive: jest.fn(() => false),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (name, task) => task()),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(async () => {}),
}));
jest.mock('../services/access-code-capture', () => ({ enabled: jest.fn(), runAccessCodeNet: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { recordMissedTick } = require('../utils/cron-lock');
const { enabled, runAccessCodeNet } = require('../services/access-code-capture');
const { initScheduledJobs } = require('../services/scheduler');

function sweepTick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes('access-code-net'));
  expect(regs).toHaveLength(1);
  // Every five minutes, off the :00/:05 mark the other five-minute jobs share.
  expect(regs[0][0]).toBe('0 3,8,13,18,23,28,33,38,43,48,53,58 * * * *');
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  enabled.mockReturnValue(true);
  runAccessCodeNet.mockResolvedValue({ scanned: 3, read: 2, found: 1, failed: 0, skipped: 1 });
});

test('gate off: the tick does nothing', async () => {
  enabled.mockReturnValue(false);
  await sweepTick()();
  expect(runAccessCodeNet).not.toHaveBeenCalled();
});

test('a pass logs its counts only', async () => {
  await sweepTick()();
  expect(runAccessCodeNet).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"found":1'));
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a tick skipped for no connection records a missed tick', async () => {
  runAccessCodeNet.mockResolvedValue({ skipped: true, reason: 'no_connection' });
  await sweepTick()();
  expect(recordMissedTick).toHaveBeenCalledWith('access-code-net', expect.any(Number), 'tick skipped: no_connection');
});

test('a tick covered by a concurrent run is not a miss', async () => {
  runAccessCodeNet.mockResolvedValue({ skipped: true, reason: 'lease_held' });
  await sweepTick()();
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a skip for a missing activation time is not a miss', async () => {
  runAccessCodeNet.mockResolvedValue({ skipped: 'activation_time_required' });
  await sweepTick()();
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a thrown sweep is logged by code and never escapes the tick', async () => {
  runAccessCodeNet.mockRejectedValue(Object.assign(new Error('binding #4821'), { code: 'ECONN' }));
  await expect(sweepTick()()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[access-codes] sweep tick failed (ECONN)');
});
