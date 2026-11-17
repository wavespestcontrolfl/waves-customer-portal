/**
 * Promise age-out in the 1:44 AM ET cron (server/services/scheduler.js): the tick runs the job under
 * runExclusive, a failed run is logged and never thrown, and a deploy kill re-runs it.
 *
 * Mock baseline copied from scheduler-alert-retention-cron.test.js.
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

jest.mock('../services/promise-age-out', () => ({ runPromiseAgeOut: jest.fn() }));
jest.mock('../utils/deploy-kill-retry', () => ({ registerDeployKillRetry: jest.fn(), retryDeployKilledJobs: jest.fn(async () => []) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runPromiseAgeOut } = require('../services/promise-age-out');
const { registerDeployKillRetry } = require('../utils/deploy-kill-retry');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function ageOutTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '44 1 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the job runs inside runExclusive', async () => {
  await ageOutTick();
  expect(runExclusive).toHaveBeenCalledWith('promise-age-out', expect.any(Function));
  expect(runPromiseAgeOut).toHaveBeenCalledTimes(1);
  expect(runPromiseAgeOut).toHaveBeenCalledWith();
});

test('a tick another instance already holds never runs a second pass', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await ageOutTick();
  expect(runPromiseAgeOut).not.toHaveBeenCalled();
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runPromiseAgeOut.mockRejectedValueOnce(new Error('boom'));
  await expect(ageOutTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[promise-age-out] tick failed: boom');
});

test('a run a deploy killed is registered to run again', async () => {
  await ageOutTick();
  const [, retry] = registerDeployKillRetry.mock.calls.find(([job]) => job === 'promise-age-out');
  runPromiseAgeOut.mockClear();
  await retry();
  expect(runPromiseAgeOut).toHaveBeenCalledTimes(1);
});
