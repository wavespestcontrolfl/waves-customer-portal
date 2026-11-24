/**
 * Technician days-off sync in the 3:25 AM ET cron (server/services/scheduler.js): the tick runs the job under
 * runExclusive and a failed run is logged and never thrown.
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

jest.mock('../services/tech-birthday-absences', () => ({ syncTechDaysOff: jest.fn() }));
jest.mock('../utils/deploy-kill-retry', () => ({ registerDeployKillRetry: jest.fn(), retryDeployKilledJobs: jest.fn(async () => []) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { syncTechDaysOff } = require('../services/tech-birthday-absences');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function tick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '25 3 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('the job runs inside runExclusive', async () => {
  await tick();
  expect(runExclusive).toHaveBeenCalledWith('tech-days-off', expect.any(Function));
  expect(syncTechDaysOff).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never runs a second pass', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await tick();
  expect(syncTechDaysOff).not.toHaveBeenCalled();
});

test('a failed run is logged, never thrown out of the tick', async () => {
  syncTechDaysOff.mockRejectedValueOnce(new Error('boom'));
  await expect(tick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[tech-days-off] daily sync failed: boom');
});
