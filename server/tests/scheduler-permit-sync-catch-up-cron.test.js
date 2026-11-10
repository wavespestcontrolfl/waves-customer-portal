/**
 * Permit-sync daily catch-up in the 7:41 AM ET cron on the six days that are not Monday
 * (server/services/scheduler.js). 2026-11-09: the county refused Monday's report downloads with HTTP 403 and
 * nothing asked again for a week. The tick takes the `permit-sync` lease only when the report step is due, runs
 * the catch-up body under it, and never throws out of the tick. Monday keeps its own full run.
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

jest.mock('../services/property-lookup/permit-sync-run', () => ({
  reportCatchUpDue: jest.fn(), runPermitReportCatchUp: jest.fn(), runPermitSyncSteps: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const permitRun = require('../services/property-lookup/permit-sync-run');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function registered(expression) {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([e]) => e === expression);
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1];
}
const catchUpTick = () => registered('41 7 * * 0,2-6')();

beforeEach(() => {
  jest.clearAllMocks();
  permitRun.reportCatchUpDue.mockResolvedValue(false);
  permitRun.runPermitReportCatchUp.mockResolvedValue({ errors: [] });
});

test('a normal week: the tick takes no lease and runs nothing', async () => {
  await catchUpTick();
  expect(permitRun.reportCatchUpDue).toHaveBeenCalledTimes(1);
  expect(runExclusive).not.toHaveBeenCalledWith('permit-sync', expect.any(Function));
  expect(permitRun.runPermitReportCatchUp).not.toHaveBeenCalled();
});

test('after a failed Monday: the report catch-up runs under the permit-sync lease, not the full Monday run', async () => {
  permitRun.reportCatchUpDue.mockResolvedValue(true);
  await catchUpTick();
  expect(runExclusive).toHaveBeenCalledWith('permit-sync', expect.any(Function));
  expect(permitRun.runPermitReportCatchUp).toHaveBeenCalledTimes(1);
  expect(permitRun.runPermitSyncSteps).not.toHaveBeenCalled();
});

test('a lease another instance holds never runs a second catch-up', async () => {
  permitRun.reportCatchUpDue.mockResolvedValue(true);
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await catchUpTick();
  expect(permitRun.runPermitReportCatchUp).not.toHaveBeenCalled();
});

test('a failed catch-up is logged, never thrown out of the tick', async () => {
  permitRun.reportCatchUpDue.mockResolvedValue(true);
  permitRun.runPermitReportCatchUp.mockRejectedValueOnce(new Error('report sync (catch-up): boom'));
  await expect(catchUpTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Permit sync catch-up lease failed: report sync (catch-up): boom');
});

test('Monday keeps its own tick: the full run (report, then detail) under the same lease', async () => {
  await registered('41 7 * * 1')();
  expect(runExclusive).toHaveBeenCalledWith('permit-sync', expect.any(Function));
  expect(permitRun.runPermitSyncSteps).toHaveBeenCalledWith({ afterKill: false });
  expect(permitRun.reportCatchUpDue).not.toHaveBeenCalled();
});
