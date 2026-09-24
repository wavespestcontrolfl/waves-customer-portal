/**
 * Nightly recurring-series top-up cron (server/services/scheduler.js,
 * '50 1 * * *') — per-series failures are already isolated inside
 * runRecurringSeriesTopUpSweep (server/tests/recurring-series-topup-sweep
 * .test.js), but the tick itself must still surface a non-empty
 * summary.errors as a FAILED job_health run (Codex GitHub r2 P2) rather
 * than reading as a clean tick just because no single series' failure
 * stopped the others.
 *
 * Mock baseline mirrors scheduler-recurring-dispatch.test.js — the set
 * already proven sufficient to load services/scheduler.js and run
 * initScheduledJobs() without touching a real DB or any other service.
 */
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  recurringSeriesTopUpLive: jest.fn(() => false),
}));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runRecurringSeriesTopUpSweep } = require('../services/recurring-series-topup');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registration = cron.schedule.mock.calls.find(([expression]) => expression === '50 1 * * *');
  expect(registration).toBeDefined();
  expect(registration[2]).toEqual({ timezone: 'America/New_York' });
  return registration[1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('a clean sweep (no per-series errors) never throws and records no failure', async () => {
  runRecurringSeriesTopUpSweep.mockResolvedValue({
    scanned: 5, toppedUp: 3, visitsInserted: 7, skipped: {}, errors: [], series: [],
  });
  await tick();
  expect(runExclusive).toHaveBeenCalledWith('recurring-series-topup', expect.any(Function));
  expect(logger.error).not.toHaveBeenCalled();
});

test('a sweep with per-series errors throws an aggregate — the tick reaches the job-failure path (Codex GitHub r2 P2)', async () => {
  runRecurringSeriesTopUpSweep.mockResolvedValue({
    scanned: 5, toppedUp: 2, visitsInserted: 4, skipped: {}, errors: [
      { parentId: 'parent-bad-1', error: 'db exploded' },
      { parentId: 'parent-bad-2', error: 'timeout' },
    ], series: [],
  });
  await tick();
  // Per-series isolation held (the sweep itself completed and returned a
  // summary rather than throwing on the first failure) — the aggregate is
  // only raised AFTER every parent was attempted, so runExclusive's own
  // job_health bookkeeping (recordJobEnd with the error) sees this tick as
  // failed instead of a silent success hiding two broken series.
  expect(logger.error).toHaveBeenCalledTimes(1);
  const [message] = logger.error.mock.calls[0];
  expect(message).toContain('2/5 series failed');
  expect(message).toContain('parent-bad-1');
});
