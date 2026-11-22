/**
 * Call booking check in its own cron (server/services/scheduler.js, '0 13,28,43,58 7-20 * * *': minutes 13, 28, 43
 * and 58 of every hour from 7 AM to 8 PM ET): the job runs under runExclusive, so a deploy overlap never raises a
 * bell twice, and a failed run is logged, never thrown out of the tick.
 *
 * Mock baseline copied from scheduler-caller-callback-bell-cron.test.js.
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

jest.mock('../services/call-booking-check', () => ({ runCallBookingCheck: jest.fn(async () => ({ raised: 1, closed: 2, candidates: 5, outcome: 'changed' })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runCallBookingCheck } = require('../services/call-booking-check');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

const EXPRESSION = '0 13,28,43,58 7-20 * * *';

function checkTick() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([expression, task]) => expression === EXPRESSION && String(task).includes('runCallBookingCheck'));
  expect(registrations).toHaveLength(1);
  expect(registrations[0][2]).toEqual({ timezone: 'America/New_York' });
  return registrations[0][1]();
}

beforeEach(() => {
  jest.clearAllMocks();
});

// The 2026-11-21 visit was wrong for 82 minutes on the day it was done: the check has to run inside that time.
test('node-cron runs the job four times an hour, at minutes 13, 28, 43 and 58, 7 AM to 8 PM', () => {
  const convert = jest.requireActual('node-cron/src/convert-expression');
  const [, minutes, hours] = convert(EXPRESSION).split(' ');
  expect(minutes).toBe('13,28,43,58');
  expect(hours).toBe('7,8,9,10,11,12,13,14,15,16,17,18,19,20');
});

test('the job runs once inside runExclusive and its outcome is logged', async () => {
  await checkTick();
  expect(runExclusive).toHaveBeenCalledWith('call-booking-check', expect.any(Function));
  expect(runCallBookingCheck).toHaveBeenCalledTimes(1);
  expect(logger.info).toHaveBeenCalledWith('Call booking check: 1 raised, 2 closed (changed)');
});

test('a run that stood down logs why', async () => {
  runCallBookingCheck.mockResolvedValueOnce({ skipped: 'episodes_off' });
  await checkTick();
  expect(logger.info).toHaveBeenCalledWith('Call booking check: 0 raised, 0 closed (episodes_off)');
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runCallBookingCheck.mockRejectedValueOnce(new Error('connection reset'));
  await expect(checkTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Call booking check failed: connection reset');
});
