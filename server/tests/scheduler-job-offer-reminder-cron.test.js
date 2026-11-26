/**
 * The job offer 2-day reminder in the scheduler (server/services/scheduler.js, '0 4,19,34,49 9-17 * * *' Eastern): the
 * one message of the offer flow that no person presses. It runs only with GATE_JOB_OFFERS and GATE_JOB_OFFER_REMINDER
 * both on; with either off the tick does nothing at all. On, it runs sendDueReminders under runExclusive, so a Railway
 * deploy overlap cannot run two passes. A reminder that failed fails the job (job_health records it) and never throws
 * out of the tick.
 *
 * Mock baseline copied from scheduler-job-offer-close-cron.test.js.
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

jest.mock('../services/job-offers', () => ({ closeExpiredOffers: jest.fn(), sendDueReminders: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { sendDueReminders } = require('../services/job-offers');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function reminderTick(gatesOn = ['jobOffers', 'jobOfferReminder']) {
  isEnabled.mockImplementation((name) => name === 'cronJobs' || gatesOn.includes(name));
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression]) => expression === '0 4,19,34,49 9-17 * * *');
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  sendDueReminders.mockResolvedValue({ reminded: 0, notSent: 0, failed: 0 });
});

test.each([
  ['both gates off', []],
  ['only GATE_JOB_OFFERS on (the state after this ships)', ['jobOffers']],
  ['only GATE_JOB_OFFER_REMINDER on', ['jobOfferReminder']],
])('with %s the tick takes no lock and reads nothing', async (_name, gatesOn) => {
  await reminderTick(gatesOn);
  expect(runExclusive).not.toHaveBeenCalledWith('job-offer-reminder', expect.any(Function));
  expect(sendDueReminders).not.toHaveBeenCalled();
});

test('with both gates on the tick runs the pass inside runExclusive, on its own clock', async () => {
  sendDueReminders.mockResolvedValue({ reminded: 2, notSent: 1, failed: 0 });
  await reminderTick();
  expect(runExclusive).toHaveBeenCalledWith('job-offer-reminder', expect.any(Function));
  expect(sendDueReminders).toHaveBeenCalledTimes(1);
  // No clock is passed: each claim reads it after its row locks.
  expect(sendDueReminders).toHaveBeenCalledWith();
  expect(logger.info).toHaveBeenCalledWith('[job-offers] reminder pass: reminded=2 not_sent=1');
  expect(logger.error).not.toHaveBeenCalled();
});

test('a tick another instance already holds never runs a second pass', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await reminderTick();
  expect(sendDueReminders).not.toHaveBeenCalled();
  expect(logger.error).not.toHaveBeenCalled();
});

test('a reminder that failed fails the job inside the lock, and the tick does not throw', async () => {
  sendDueReminders.mockResolvedValue({ reminded: 1, notSent: 0, failed: 2 });
  let thrownInLock = null;
  runExclusive.mockImplementationOnce(async (_key, task) => {
    try { return await task(); } catch (err) { thrownInLock = err; throw err; }
  });
  await expect(reminderTick()).resolves.toBeUndefined();
  expect(thrownInLock).toEqual(new Error('2 reminder(s) failed'));
  expect(logger.error).toHaveBeenCalledWith('[job-offers] reminder pass failed: 2 reminder(s) failed');
});
