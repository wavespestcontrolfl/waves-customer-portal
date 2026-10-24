/**
 * The plan-rate ledger reconcile cron (GATE_PLAN_RATE_LEDGER_RECONCILE): registered once, daily 6:47am ET
 * through the shared scheduler as a locked runExclusive job; dark means the tick takes no lock and runs
 * nothing (so no query, no write, no job_health row); a failed run or a missed tick reaches job_health like
 * its neighbours; and a deploy that kills the run re-runs the same tick. Same mocking shape as
 * scheduler-reclaimed-water.test.js.
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
  planRateLedgerReconcileLive: jest.fn(() => mockGate.on),
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
jest.mock('../utils/deploy-kill-retry', () => ({ registerDeployKillRetry: jest.fn(), retryDeployKilledJobs: jest.fn(async () => {}) }));
jest.mock('../services/plan-rate-ledger-reconcile', () => ({ runPlanRateLedgerReconcile: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { recordMissedTick, runExclusive } = require('../utils/cron-lock');
const { registerDeployKillRetry } = require('../utils/deploy-kill-retry');
const { runPlanRateLedgerReconcile } = require('../services/plan-rate-ledger-reconcile');
const { initScheduledJobs } = require('../services/scheduler');

const JOB = 'plan-rate-ledger-reconcile';

function registration() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes(`'${JOB}'`));
  expect(regs).toHaveLength(1);
  return regs[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
  mockLock.skip = null;
  mockGate.on = true;
  runPlanRateLedgerReconcile.mockResolvedValue({ skipped: false, checked: 1, parked: 1, overshoots: 0, converged: 0, alerted: 1, alreadyAlerted: 0, deferred: 0, failed: 0 });
});

test('one registration, 6:47am every day, Eastern time', () => {
  const [expression, , options] = registration();
  expect(expression).toBe('47 6 * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
});

test('a deploy that kills the run re-runs the same tick', () => {
  const [, tick] = registration();
  const retries = registerDeployKillRetry.mock.calls.filter(([name]) => name === JOB);
  expect(retries).toHaveLength(1);
  expect(retries[0][1]).toBe(tick);
});

test('a clean tick runs the reconcile once under its own lock name and records success', async () => {
  await registration()[1]();
  expect(runExclusive).toHaveBeenCalledWith(JOB, expect.any(Function));
  expect(runPlanRateLedgerReconcile).toHaveBeenCalledTimes(1);
  expect(mockJobOutcomes[JOB]).toBe('success');
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('the gate off: the tick takes no lock and runs nothing', async () => {
  mockGate.on = false;
  await registration()[1]();
  expect(runExclusive).not.toHaveBeenCalled();
  expect(runPlanRateLedgerReconcile).not.toHaveBeenCalled();
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a run that skipped itself (gate flipped mid-tick) is not mistaken for a missed tick', async () => {
  runPlanRateLedgerReconcile.mockResolvedValue({ skipped: true, reason: 'gated_off' });
  await registration()[1]();
  expect(mockJobOutcomes[JOB]).toBe('success');
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a failed run (a customer it could not reconcile) records a failed run', async () => {
  runPlanRateLedgerReconcile.mockRejectedValue(new Error('plan-rate ledger reconcile: 1 customer(s) failed'));
  await registration()[1]();
  expect(mockJobOutcomes[JOB]).toBe('failed: plan-rate ledger reconcile: 1 customer(s) failed');
});

test('a tick skipped for no connection records a missed tick; one covered by a concurrent run records nothing', async () => {
  const tick = registration()[1];
  mockLock.skip = 'no_connection';
  await tick();
  expect(recordMissedTick).toHaveBeenCalledWith(JOB, expect.any(Number), 'tick skipped: no_connection');
  recordMissedTick.mockClear();
  mockLock.skip = 'lease_held';
  await tick();
  expect(recordMissedTick).not.toHaveBeenCalled();
});
