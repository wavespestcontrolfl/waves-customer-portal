/**
 * The Intelligence Bar cancel recovery cron: every 5 minutes, under runExclusive, no gate of its own (the rows exist only
 * after the gated card path ran). A clean pass is a successful run; a pass where a bundle failed is a failed run in
 * job health (the row stays pending for the next tick); a lost lease (the request finished first) is not a failure.
 * Same mocking shape as scheduler-day-agreement-shadow.test.js.
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
jest.mock('../services/ib-cancel-effect-bundles', () => ({ sweepIbCancelBundles: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const logger = require('../services/logger');
const { sweepIbCancelBundles } = require('../services/ib-cancel-effect-bundles');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes("runExclusive('ib-cancel-effect-recovery'"));
  expect(regs).toHaveLength(1);
  expect(regs[0][0]).toBe('*/5 * * * *');
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHealth.length = 0;
  sweepIbCancelBundles.mockResolvedValue({ recovered: 0, abandoned: 0, deferred: 0, failed: 0, reported: 0, lost: 0 });
});

test('an empty pass is a quiet successful run', async () => {
  await tick()();
  expect(sweepIbCancelBundles).toHaveBeenCalledTimes(1);
  expect(mockHealth).toEqual([['ib-cancel-effect-recovery', 'ok']]);
  expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('[ib-cancel-bundle]'));
});

test('a pass that finished a bundle logs its counts', async () => {
  sweepIbCancelBundles.mockResolvedValue({ recovered: 1, abandoned: 0, deferred: 0, failed: 0, reported: 0, lost: 0 });
  await tick()();
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"recovered":1'));
  expect(mockHealth).toEqual([['ib-cancel-effect-recovery', 'ok']]);
});

test('a bundle that failed is a failed run in job health and never escapes the tick', async () => {
  sweepIbCancelBundles.mockResolvedValue({ recovered: 0, abandoned: 0, deferred: 0, failed: 1, reported: 0, lost: 0 });
  await expect(tick()()).resolves.toBeUndefined();
  expect(mockHealth).toEqual([['ib-cancel-effect-recovery', 'failed', 'SWEEP_INCOMPLETE']]);
});

test('a lost lease (the request finished first) is not a failure', async () => {
  sweepIbCancelBundles.mockResolvedValue({ recovered: 0, abandoned: 0, deferred: 0, failed: 0, reported: 0, lost: 1 });
  await tick()();
  expect(mockHealth).toEqual([['ib-cancel-effect-recovery', 'ok']]);
});

test('a sweep that throws is a failed run too', async () => {
  sweepIbCancelBundles.mockRejectedValue(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
  await tick()();
  expect(mockHealth).toEqual([['ib-cancel-effect-recovery', 'failed', 'ECONNRESET']]);
});
