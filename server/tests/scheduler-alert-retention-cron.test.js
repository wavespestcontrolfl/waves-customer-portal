/**
 * Admin alert retention in the 1:32 AM ET cron (server/services/scheduler.js): gate off returns before the lock,
 * gate on runs the sweep under runExclusive, a failed sweep is logged and never thrown, and a deploy kill re-runs it.
 *
 * Mock baseline copied from scheduler-bid-kit-expiry-cron.test.js.
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
  recurringSeriesTopUpLive: jest.fn(() => false), alertRetentionMode: jest.fn(() => 'off'),
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

jest.mock('../services/admin-alert-retention', () => ({ runAdminAlertRetention: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, alertRetentionMode } = require('../config/feature-gates');
const { runAdminAlertRetention } = require('../services/admin-alert-retention');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function retentionTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '32 1 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  alertRetentionMode.mockReturnValue('off');
});

test('gate off: the tick returns before the lock and the sweep', async () => {
  await retentionTick();
  expect(runExclusive).not.toHaveBeenCalledWith('admin-alert-retention', expect.any(Function));
  expect(runAdminAlertRetention).not.toHaveBeenCalled();
});

test.each(['shadow', 'true'])('gate %s: the sweep runs inside runExclusive', async (mode) => {
  alertRetentionMode.mockReturnValue(mode);
  await retentionTick();
  expect(runExclusive).toHaveBeenCalledWith('admin-alert-retention', expect.any(Function));
  expect(runAdminAlertRetention).toHaveBeenCalledTimes(1);
});

test('a tick another instance already holds never runs a second sweep', async () => {
  alertRetentionMode.mockReturnValue('true');
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await retentionTick();
  expect(runAdminAlertRetention).not.toHaveBeenCalled();
});

test('a failed sweep is logged, never thrown out of the tick', async () => {
  alertRetentionMode.mockReturnValue('true');
  runAdminAlertRetention.mockRejectedValueOnce(new Error('boom'));
  await expect(retentionTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('[alert-retention] sweep tick failed: boom');
});
