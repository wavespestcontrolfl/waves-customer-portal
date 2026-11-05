/**
 * 4:20 AM route re-order cron (server/services/scheduler.js, '20 4 * * *'): the inner borrow of the 4:10 writer
 * lock ('auto-dispatch-recurring') waits up to 25 minutes only when GATE_NIGHT_PASS_WAIT is on (call-time read);
 * a wait that runs out still ledgers the skipped tick and fails the outer job, exactly as before.
 *
 * Mock baseline copied from scheduler-day-replan-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), dayReplanMode: jest.fn(() => 'off'),
  nightPassWaitLive: jest.fn(() => false),
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

jest.mock('../services/route-reorder', () => ({
  runRouteReorderIfEnabled: jest.fn(),
  recordSkippedTick: jest.fn(),
  runScheduleQualityAlertsOnly: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, gateEnvValue, nightPassWaitLive } = require('../config/feature-gates');
const { runRouteReorderIfEnabled, recordSkippedTick } = require('../services/route-reorder');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function registration() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const found = cron.schedule.mock.calls.filter(([expression, task]) => expression === '20 4 * * *' && String(task).includes("'route-tiers-nightly'"));
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  gateEnvValue.mockReturnValue(true);
  nightPassWaitLive.mockReturnValue(false);
  runExclusive.mockImplementation(async (_key, task) => task());
  runRouteReorderIfEnabled.mockResolvedValue({ status: 'completed', applied: 1, skipped: 0, failed: 0, ledgerId: 7 });
});

test('gate off: the inner writer-lock call carries no wait option (behavior unchanged)', async () => {
  await registration()[1]();
  expect(runExclusive.mock.calls.map(([name]) => name)).toEqual(['route-tiers-nightly', 'auto-dispatch-recurring']);
  expect(runExclusive.mock.calls[1][2]).toEqual({ recordHealth: false });
  expect(runRouteReorderIfEnabled).toHaveBeenCalledTimes(1);
});

test('gate on: only the inner writer-lock call waits, up to 25 minutes', async () => {
  nightPassWaitLive.mockReturnValue(true);
  await registration()[1]();
  expect(runExclusive.mock.calls[0][2]).toBeUndefined();
  expect(runExclusive.mock.calls[1][2]).toEqual({ recordHealth: false, waitForLockMs: 25 * 60 * 1000 });
  expect(runRouteReorderIfEnabled).toHaveBeenCalledTimes(1);
});

test('a wait that runs out still ledgers the skipped tick and fails the outer job', async () => {
  nightPassWaitLive.mockReturnValue(true);
  recordSkippedTick.mockResolvedValue(9);
  runExclusive.mockImplementation(async (name, task) => (name === 'auto-dispatch-recurring' ? { skipped: true, reason: 'lease_held' } : task()));
  await registration()[1]();
  expect(recordSkippedTick).toHaveBeenCalledWith('lease_held');
  expect(runRouteReorderIfEnabled).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('route-reorder tick skipped (lease_held)'));
});
