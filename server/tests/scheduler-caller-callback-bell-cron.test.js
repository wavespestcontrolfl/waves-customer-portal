/**
 * Caller callback late bell in its own cron (server/services/scheduler.js, '0 5,20,35,50 8-20 * * *': minutes 5, 20, 35
 * and 50 of every hour from 8 AM to 8 PM ET): gate off reads nothing; on, the job runs under runExclusive, so a
 * deploy overlap never raises it twice, and a failed run is logged, never thrown out of the tick.
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
  recurringSeriesTopUpLive: jest.fn(() => false), callerCallbackBellLive: jest.fn(() => false),
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

jest.mock('../services/caller-callback-bell', () => ({ runCallerCallbackBell: jest.fn(async () => ({ raised: 2, closed: 1, candidates: 4, outcome: 'changed' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, callerCallbackBellLive } = require('../config/feature-gates');
const { runCallerCallbackBell } = require('../services/caller-callback-bell');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

const EXPRESSION = '0 5,20,35,50 8-20 * * *';

function bellTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === EXPRESSION && String(task).includes('runCallerCallbackBell'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
  callerCallbackBellLive.mockReturnValue(false);
});

// node-cron 3 reads a stepped range ('5-59/15') as the range values divisible by the step (15, 30, 45): one run an
// hour short and on the follow-up pager's minutes. Read the expression the way node-cron itself does.
test('node-cron runs the job four times an hour, at minutes 5, 20, 35 and 50, 8 AM to 8 PM', () => {
  const convert = jest.requireActual('node-cron/src/convert-expression');
  const [, minutes, hours] = convert(EXPRESSION).split(' ');
  expect(minutes).toBe('5,20,35,50');
  expect(hours).toBe('8,9,10,11,12,13,14,15,16,17,18,19,20');
  expect(convert('0 5-59/15 8-20 * * *').split(' ')[1]).toBe('15,30,45');
});

test('gate off: the tick returns before the lock or any read', async () => {
  await bellTick();
  expect(runExclusive).not.toHaveBeenCalledWith('caller-callback-bell', expect.any(Function));
  expect(runCallerCallbackBell).not.toHaveBeenCalled();
});

test('gate on: the job runs once inside runExclusive and its outcome is logged', async () => {
  callerCallbackBellLive.mockReturnValue(true);
  await bellTick();
  expect(runExclusive).toHaveBeenCalledWith('caller-callback-bell', expect.any(Function));
  expect(runCallerCallbackBell).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Caller callback bell: 2 raised, 1 closed (changed)');
});

test('gate on: a run that closed promises says so in the log line', async () => {
  callerCallbackBellLive.mockReturnValue(true);
  runCallerCallbackBell.mockResolvedValueOnce({ raised: 0, closed: 1, promisesClosed: 3, candidates: 4, outcome: 'changed' });
  await bellTick();
  expect(logger.info).toHaveBeenCalledWith('Caller callback bell: 0 raised, 1 closed, 3 promises closed (changed)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  callerCallbackBellLive.mockReturnValue(true);
  runCallerCallbackBell.mockRejectedValueOnce(new Error('connection reset'));
  await expect(bellTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Caller callback bell failed: connection reset');
});
