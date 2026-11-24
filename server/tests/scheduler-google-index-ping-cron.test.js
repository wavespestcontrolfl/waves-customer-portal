/**
 * Google index ping in the every-2-hours :53 ET cron (server/services/scheduler.js): the tick runs under
 * runExclusive, a failed run is logged and never thrown out of the tick.
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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []), recordMissedTick: jest.fn(async () => {}) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));

jest.mock('../services/seo/google-index-ping', () => ({ runGoogleIndexPing: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runGoogleIndexPing } = require('../services/seo/google-index-ping');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function pingTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '53 */2 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  runExclusive.mockImplementation(async (_key, task) => task());
});

test('the ping runs inside runExclusive', async () => {
  await pingTick();
  expect(runExclusive).toHaveBeenCalledWith('google-index-ping', expect.any(Function));
  expect(runGoogleIndexPing).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never runs a second ping', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await pingTick();
  expect(runGoogleIndexPing).not.toHaveBeenCalled();
});

test('a run that reports errors fails the lease body so job_health records it, and the tick still never throws', async () => {
  runGoogleIndexPing.mockResolvedValueOnce({ errors: 2 });
  await expect(pingTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[google-index-ping] tick failed: google index ping finished with 2 error(s)');
});

test('a clean run does not fail the lease body', async () => {
  runGoogleIndexPing.mockResolvedValueOnce({ errors: 0, updated: 1 });
  await pingTick();
  expect(logger.error).not.toHaveBeenCalled();
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runGoogleIndexPing.mockRejectedValueOnce(new Error('boom'));
  await expect(pingTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[google-index-ping] tick failed: boom');
});
