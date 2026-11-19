/**
 * The "Call today" estimate banner in its own daily 9:00 AM ET cron (server/services/scheduler.js, '0 9 * * *'):
 * the job runs under runExclusive (the per-ET-day claim inside it stops a second banner), a failed run is logged,
 * never thrown out of the tick, and the schedule is 9:00 in America/New_York on every date, the clock-change days
 * included.
 *
 * Mock baseline copied from scheduler-morning-banner-cron.test.js.
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

jest.mock('../services/estimate-call-today-push', () => ({ runEstimateCallTodayPush: jest.fn(async () => ({ count: 2, sent: true })) }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runEstimateCallTodayPush } = require('../services/estimate-call-today-push');
const { parseETDateTime, etDateString } = require('../utils/datetime-et');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function pushRegistration() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  const registrations = cron.schedule.mock.calls.filter(([, task]) => String(task).includes('runEstimateCallTodayPush'));
  expect(registrations).toHaveLength(1);
  return registrations[0];
}
const pushTick = () => pushRegistration()[1]();

beforeEach(() => {
  jest.clearAllMocks();
});

test('registered once, at 9:00 every day, on the Eastern clock', () => {
  const [expression, , options] = pushRegistration();
  expect(expression).toBe('0 9 * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
});

test('9:00 AM Eastern is a real, single instant on the clock-change days, and the day key is that ET date', () => {
  // Spring forward 2026-03-08 and fall back 2026-11-01 both change the clocks at 2 AM, before 9:00.
  const cases = [['2026-03-07', '14:00'], ['2026-03-08', '13:00'], ['2026-03-09', '13:00'], ['2026-10-31', '13:00'], ['2026-11-01', '14:00'], ['2026-11-02', '14:00']];
  for (const [day, utcTime] of cases) {
    const fire = parseETDateTime(`${day}T09:00`);
    expect(fire.toISOString()).toBe(`${day}T${utcTime}:00.000Z`);
    expect(etDateString(fire)).toBe(day);
  }
});

test('the job runs once inside runExclusive', async () => {
  await pushTick();
  expect(runExclusive).toHaveBeenCalledWith('estimate-call-today-push', expect.any(Function));
  expect(runEstimateCallTodayPush).toHaveBeenCalledTimes(1);
});

test('a failed run is logged, never thrown out of the tick', async () => {
  runEstimateCallTodayPush.mockRejectedValueOnce(new Error('connection reset'));
  await expect(pushTick()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith('Estimate call-today push failed: connection reset');
});

// Job health (cron-lock runExclusive) records a resolved callback as a success and a thrown one as a failure.
test('a count, claim or delivery failure reported by the worker is thrown inside the runExclusive callback', async () => {
  for (const error of ['count_failed', 'claim_failed', 'dispatch_failed', 'delivery_uncertain', 'push_dispatch_failed', 'claim_release_failed']) {
    jest.clearAllMocks();
    runEstimateCallTodayPush.mockResolvedValueOnce({ count: 1, sent: false, error });
    let thrown;
    runExclusive.mockImplementationOnce(async (_key, task) => {
      try { return await task(); } catch (err) { thrown = err; throw err; }
    });
    await expect(pushTick()).resolves.toBeUndefined();
    expect(thrown).toEqual(new Error(`estimate call-today push: ${error}`)); // a fixed code, never a database error text
    expect(logger.error).toHaveBeenCalledWith(`Estimate call-today push failed: estimate call-today push: ${error}`);
  }
});

test('a skip stays a success: nothing on the list, already claimed, no device to send to', async () => {
  for (const skipped of ['nothing_to_call', 'already_claimed', 'no_push_delivered']) {
    jest.clearAllMocks();
    runEstimateCallTodayPush.mockResolvedValueOnce({ count: 0, sent: false, skipped });
    let outcome = 'pending';
    runExclusive.mockImplementationOnce(async (_key, task) => {
      try { const result = await task(); outcome = 'resolved'; return result; } catch (err) { outcome = 'thrown'; throw err; }
    });
    await pushTick();
    expect(outcome).toBe('resolved');
    expect(logger.error).not.toHaveBeenCalled();
  }
});
