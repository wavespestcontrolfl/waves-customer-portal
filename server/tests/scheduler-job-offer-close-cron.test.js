/**
 * The job offer 7-day close in the scheduler (server/services/scheduler.js, '0 9,24,39,54 * * * *'): with
 * GATE_JOB_OFFERS off the tick does nothing at all; on, it runs closeExpiredOffers under runExclusive, so a Railway
 * deploy overlap cannot run two passes that each ring the bell. An offer that did not close fails the job (job_health
 * records it) and never throws out of the tick. The same tick then runs the staff record pass (makeDueStaffRecords) as
 * its own job, whatever the close did.
 *
 * Mock baseline copied from scheduler-bi-briefing-cron.test.js.
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

jest.mock('../services/job-offers', () => ({ closeExpiredOffers: jest.fn(), makeDueStaffRecords: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { closeExpiredOffers, makeDueStaffRecords } = require('../services/job-offers');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function closeTick({ gateOn = true } = {}) {
  isEnabled.mockImplementation((name) => name === 'cronJobs' || (gateOn && name === 'jobOffers'));
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '0 9,24,39,54 * * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  closeExpiredOffers.mockResolvedValue({ closed: 0, failed: 0 });
  makeDueStaffRecords.mockResolvedValue({ made: 0, refused: 0, failed: 0 });
});

test('with the gate off the tick takes no lock and reads nothing', async () => {
  await closeTick({ gateOn: false });
  expect(runExclusive).not.toHaveBeenCalledWith('job-offer-close', expect.any(Function));
  expect(runExclusive).not.toHaveBeenCalledWith('job-offer-staff-records', expect.any(Function));
  expect(closeExpiredOffers).not.toHaveBeenCalled();
  expect(makeDueStaffRecords).not.toHaveBeenCalled();
});

test('with the gate on the tick runs the close inside runExclusive', async () => {
  closeExpiredOffers.mockResolvedValue({ closed: 2, failed: 0 });
  await closeTick();
  expect(runExclusive).toHaveBeenCalledWith('job-offer-close', expect.any(Function));
  expect(closeExpiredOffers).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});

test('a tick another instance already holds never runs a second pass', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await closeTick();
  expect(closeExpiredOffers).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

test('an offer that did not close fails the job inside the lock, and the tick does not throw', async () => {
  closeExpiredOffers.mockResolvedValue({ closed: 1, failed: 2 });
  let thrownInLock = null;
  runExclusive.mockImplementationOnce(async (_key, task) => {
    try { return await task(); } catch (err) { thrownInLock = err; throw err; }
  });
  await expect(closeTick()).resolves.toBeUndefined();
  expect(thrownInLock).toEqual(new Error('2 offer(s) did not close'));
  expect(logger.error).toHaveBeenCalledWith('[job-offers] close sweep failed: 2 offer(s) did not close');
});

test('with the gate on the tick runs the staff record pass as its own job', async () => {
  makeDueStaffRecords.mockResolvedValue({ made: 1, refused: 1, failed: 0 });
  await closeTick();
  expect(runExclusive).toHaveBeenCalledWith('job-offer-staff-records', expect.any(Function));
  expect(makeDueStaffRecords).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('[job-offers] staff record pass: made=1 refused=1');
  expect(logger.error).not.toHaveBeenCalled();
});

test('a close that failed does not stop the staff record pass', async () => {
  closeExpiredOffers.mockRejectedValue(new Error('db down'));
  await expect(closeTick()).resolves.toBeUndefined();
  expect(makeDueStaffRecords).toHaveBeenCalledTimes(1);
});

test('a staff record that was not made fails its job inside the lock, and the tick does not throw', async () => {
  makeDueStaffRecords.mockResolvedValue({ made: 0, refused: 0, failed: 1 });
  const thrownInLock = {};
  runExclusive.mockImplementation(async (key, task) => {
    try { return await task(); } catch (err) { thrownInLock[key] = err; throw err; }
  });
  await expect(closeTick()).resolves.toBeUndefined();
  expect(thrownInLock).toEqual({ 'job-offer-staff-records': new Error('1 staff record(s) not made') });
  expect(logger.error).toHaveBeenCalledWith('[job-offers] staff record pass failed: 1 staff record(s) not made');
});
