/**
 * New-home price ticks (server/services/scheduler.js): every day at 9:51 PM ET and weekdays at 12:51 PM ET, twenty
 * minutes after the list ticks, both under ONE `mail-home-price` lease, plus the deploy-kill retry. Inside that lease the
 * run also takes the permit sync's lease (no health row of its own), so the two readers of the county permit site never
 * run at once. A failed run is logged, never thrown out of the tick. Mock baseline copied from
 * scheduler-mail-new-home-list-cron.test.js.
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
jest.mock('../services/mail/home-price', () => ({ runHomePrices: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { registerDeployKillRetry } = require('../utils/deploy-kill-retry');
const { isEnabled } = require('../config/feature-gates');
const { runHomePrices } = require('../services/mail/home-price');
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
const leases = () => runExclusive.mock.calls.map(([name, , options]) => [name, options]);

beforeEach(() => {
  jest.clearAllMocks();
  runExclusive.mockImplementation(async (_key, task) => task());
  runHomePrices.mockResolvedValue({ due: 0 });
});

test('the night run: every day at 9:51 PM ET, under the mail-home-price lease and, inside it, the permit sync lease with no health row', async () => {
  await registered('51 21 * * *')();
  expect(leases()).toEqual([['mail-home-price', undefined], ['permit-sync', { recordHealth: false }]]);
  expect(runHomePrices).toHaveBeenCalledTimes(1);
  expect(runHomePrices).toHaveBeenCalledWith();
});

test('the noon run: weekdays at 12:51 PM ET, under the same two leases', async () => {
  await registered('51 12 * * 1-5')();
  expect(leases()).toEqual([['mail-home-price', undefined], ['permit-sync', { recordHealth: false }]]);
  expect(runHomePrices).toHaveBeenCalledTimes(1);
});

test('each price tick is 20 minutes after a list tick', () => {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const expressions = cron.schedule.mock.calls.map(([e]) => e);
  expect(expressions).toEqual(expect.arrayContaining(['31 21 * * *', '51 21 * * *', '31 12 * * 1-5', '51 12 * * 1-5']));
});

test('a mail-home-price lease another instance holds runs nothing', async () => {
  runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await registered('51 21 * * *')();
  expect(runExclusive).toHaveBeenCalledTimes(1);
  expect(runHomePrices).not.toHaveBeenCalled();
});

test('the permit sync holds its lease: no home is priced, the tick says so and is not a failed run', async () => {
  runExclusive
    .mockImplementationOnce(async (_key, task) => task())
    .mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
  await expect(registered('51 21 * * *')()).resolves.toBeUndefined();
  expect(runHomePrices).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith('Mail home prices: not run, the permit sync holds its lease (lease_held)');
  expect(logger.error).not.toHaveBeenCalled();
});

test('a failed run is logged, never thrown out of the tick, and it fails the mail-home-price lease', async () => {
  const failure = new Error('Mail home prices: the permit page did not answer (5 failures in a row)');
  runHomePrices.mockRejectedValueOnce(failure);
  let outer;
  runExclusive.mockImplementationOnce(async (_key, task) => { outer = task(); return outer; });
  await expect(registered('51 21 * * *')()).resolves.toBeUndefined();
  // The error leaves the inner lease and the outer task, so the outer lease records the failed run.
  await expect(outer).rejects.toBe(failure);
  expect(logger.error).toHaveBeenCalledWith('Mail home prices failed: Mail home prices: the permit page did not answer (5 failures in a row)');
});

test('a run a deploy killed is retried under the same two leases', async () => {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const call = registerDeployKillRetry.mock.calls.find(([name]) => name === 'mail-home-price');
  expect(call).toBeDefined();
  await call[1]();
  expect(leases()).toEqual([['mail-home-price', undefined], ['permit-sync', { recordHealth: false }]]);
  expect(runHomePrices).toHaveBeenCalledTimes(1);
});
