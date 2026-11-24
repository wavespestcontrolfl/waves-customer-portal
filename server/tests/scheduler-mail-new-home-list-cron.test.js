/**
 * New-home mail list ticks (server/services/scheduler.js): a night run every day at 9:31 PM ET and a weekday noon run
 * at 12:31 PM ET, both under ONE `mail-new-home-list` lease, plus the deploy-kill retry (mode retry: the noon window). A failed
 * run is logged, never thrown out of the tick. Mock baseline copied from scheduler-permit-sync-catch-up-cron.test.js.
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
jest.mock('../utils/deploy-kill-retry', () => ({ registerDeployKillRetry: jest.fn(), retryDeployKilledJobs: jest.fn() }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));
jest.mock('../services/mail/new-home-list', () => ({ runNewHomeList: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { registerDeployKillRetry } = require('../utils/deploy-kill-retry');
const { isEnabled } = require('../config/feature-gates');
const { runNewHomeList } = require('../services/mail/new-home-list');
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

beforeEach(() => {
  jest.clearAllMocks();
  runNewHomeList.mockResolvedValue({});
});

test('the night run: every day at 9:31 PM ET, mode night, under the mail-new-home-list lease', async () => {
  await registered('31 21 * * *')();
  expect(runExclusive).toHaveBeenCalledWith('mail-new-home-list', expect.any(Function));
  expect(runNewHomeList).toHaveBeenCalledWith({ mode: 'night' });
});

test('the noon run: weekdays at 12:31 PM ET, mode noon, under the same lease', async () => {
  await registered('31 12 * * 1-5')();
  expect(runExclusive).toHaveBeenCalledWith('mail-new-home-list', expect.any(Function));
  expect(runNewHomeList).toHaveBeenCalledWith({ mode: 'noon' });
});

test('a lease another instance holds runs nothing', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await registered('31 21 * * *')();
  expect(runNewHomeList).not.toHaveBeenCalled();
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runNewHomeList.mockRejectedValueOnce(new Error('Mail new-home list: 1 of 4 days failed (2026-11-16: http_status)'));
  await expect(registered('31 21 * * *')()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Mail new-home list failed: Mail new-home list: 1 of 4 days failed (2026-11-16: http_status)');
});

test('a run a deploy killed is retried with the wider noon window (mode retry), under the same lease', async () => {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const call = registerDeployKillRetry.mock.calls.find(([name]) => name === 'mail-new-home-list');
  expect(call).toBeDefined();
  await call[1]();
  expect(runExclusive).toHaveBeenCalledWith('mail-new-home-list', expect.any(Function));
  // Retry: the noon window (it covers a killed noon or night run), with night last-read rules.
  expect(runNewHomeList).toHaveBeenCalledTimes(1);
  expect(runNewHomeList).toHaveBeenCalledWith({ mode: 'retry' });
});
