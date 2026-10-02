/**
 * The neighborhood gate-code sweep cron must report to job_health: a pass with
 * failed customer filings is a failed run, and a tick skipped for lack of a
 * connection is a missed tick. A tick covered by a concurrent run (lease_held)
 * is not. Same mocking shape as scheduler-ads-sync-health.test.js.
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
  neighborhoodAccessLive: jest.fn(() => true),
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
jest.mock('../services/neighborhood-access', () => ({ sweepSavedGateCodes: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { recordMissedTick } = require('../utils/cron-lock');
const { sweepSavedGateCodes } = require('../services/neighborhood-access');
const { initScheduledJobs } = require('../services/scheduler');

function sweepTick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => cb.toString().includes('neighborhood-gate-codes'));
  expect(regs).toHaveLength(1);
  return regs[0][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockJobOutcomes)) delete mockJobOutcomes[k];
  mockLock.skip = null;
  sweepSavedGateCodes.mockResolvedValue({ customers: 2, tally: { filed: 2 }, failed: 0, conflicts: 0 });
});

test('a clean pass records success', async () => {
  await sweepTick()();
  expect(mockJobOutcomes['neighborhood-gate-codes']).toBe('success');
  expect(recordMissedTick).not.toHaveBeenCalled();
});

test('a pass with failed filings records a failed run', async () => {
  sweepSavedGateCodes.mockResolvedValue({ customers: 2, tally: { filed: 1 }, failed: 1, conflicts: 0 });
  await sweepTick()();
  expect(mockJobOutcomes['neighborhood-gate-codes']).toBe('failed: 1 gate-code filing(s) failed');
});

test('a pass with failed conflict bells records a failed run', async () => {
  sweepSavedGateCodes.mockResolvedValue({ customers: 1, tally: { filed_conflict: 1 }, failed: 0, bellsFailed: 1, conflicts: 1 });
  await sweepTick()();
  expect(mockJobOutcomes['neighborhood-gate-codes']).toBe('failed: 1 gate-code conflict bell step(s) failed');
});

test('a tick skipped for no connection records a missed tick', async () => {
  mockLock.skip = 'no_connection';
  await sweepTick()();
  expect(recordMissedTick).toHaveBeenCalledWith('neighborhood-gate-codes', expect.any(Number), 'tick skipped: no_connection');
});

test('a tick covered by a concurrent run records nothing', async () => {
  mockLock.skip = 'lease_held';
  await sweepTick()();
  expect(recordMissedTick).not.toHaveBeenCalled();
});
