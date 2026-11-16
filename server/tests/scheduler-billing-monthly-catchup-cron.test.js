/**
 * Monthly billing catch-up ticks in server/services/scheduler.js (GATE_BILLING_MONTHLY_CATCHUP,
 * owner 2026-11-06 O1). The 8:00 AM ET dues tick runs today's billing and keeps the bookmark;
 * the 10:29 and 14:29 ET catch-up ticks bill a missed date under the SAME 'billing-monthly'
 * lock, so they never overlap the 8:00 run. The catch-up service is faked here; its decisions
 * are tested in billing-monthly-catchup.test.js.
 *
 * Mock baseline copied from scheduler-report-catchup-cron.test.js.
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
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_key, task) => task()), settleDeadRunningJobs: jest.fn(async () => []), recordMissedTick: jest.fn(async () => {}) }));
jest.mock('../services/auto-dispatch', () => ({ runAutoDispatch: jest.fn() }));
jest.mock('../services/auto-dispatch/audit', () => ({ flagUnplacedVisits: jest.fn() }));
jest.mock('../services/time-tracking-crons', () => ({ initTimeTrackingCrons: jest.fn() }));
jest.mock('../services/equipment-crons', () => ({ initEquipmentCrons: jest.fn() }));
jest.mock('../services/bouncie-mileage-crons', () => ({ initBouncieMileageCrons: jest.fn() }));
jest.mock('../services/analytics/ga4-crons', () => ({ initGA4Crons: jest.fn() }));
jest.mock('../services/intelligence-bar/threads', () => ({ purgeExpiredThreads: jest.fn().mockResolvedValue({ deleted: 0 }) }));
jest.mock('../services/intelligence-bar/tasks', () => ({ purgeExpiredTasks: jest.fn().mockResolvedValue(1) }));
jest.mock('../services/recurring-series-topup', () => ({ runRecurringSeriesTopUpSweep: jest.fn() }));

jest.mock('../services/billing-monthly-catchup', () => ({
  catchUpNeeded: jest.fn(),
  runMonthlyBillingCatchUp: jest.fn().mockResolvedValue({ runs: [] }),
  runMonthlyBillingTick: jest.fn().mockResolvedValue({ charged: 2, processing: 0, failed: 1, skipped: 4, billingDate: '2026-11-12' }),
}));
jest.mock('../services/billing-cron', () => ({ processMonthlyBilling: jest.fn(), processPaymentRetries: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const logger = require('../services/logger');
const catchUp = require('../services/billing-monthly-catchup');
const BillingCron = require('../services/billing-cron');
const { initScheduledJobs } = require('../services/scheduler');

let registrations = null;
function tick(expression, handlerSource) {
  if (!registrations) {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    initScheduledJobs();
    registrations = cron.schedule.mock.calls.map(([expr, fn, opts]) => ({ expr, fn, opts }));
  }
  const matches = registrations.filter((r) => r.expr === expression
    && (!handlerSource || String(r.fn).includes(handlerSource)));
  expect(matches).toHaveLength(1);
  expect(matches[0].opts).toEqual({ timezone: 'America/New_York' });
  return matches[0].fn;
}

beforeEach(() => {
  jest.clearAllMocks();
  runExclusive.mockImplementation(async (_key, task) => task());
  isEnabled.mockImplementation((name) => name === 'cronJobs');
});

describe('monthly billing catch-up (10:29 + 14:29 ET)', () => {
  const runCatchUp = () => tick('29 10,14 * * *', 'runMonthlyBillingCatchUp')();

  test('nothing owed (or gate off, or an unreadable bookmark): no lock, no billing', async () => {
    catchUp.catchUpNeeded.mockResolvedValue(false);
    await runCatchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(catchUp.runMonthlyBillingCatchUp).not.toHaveBeenCalled();
  });

  test('a date owed: bills it under the 8:00 run\'s own billing-monthly lock', async () => {
    catchUp.catchUpNeeded.mockResolvedValue(true);
    await runCatchUp();
    expect(runExclusive).toHaveBeenCalledWith('billing-monthly', expect.any(Function));
    expect(catchUp.runMonthlyBillingCatchUp).toHaveBeenCalledTimes(1);
  });

  test('a catch-up that throws is logged, never thrown out of the tick', async () => {
    catchUp.catchUpNeeded.mockResolvedValue(true);
    catchUp.runMonthlyBillingCatchUp.mockRejectedValueOnce(new Error('bookmark read failed'));
    runExclusive.mockImplementationOnce(async (_key, task) => task());
    await expect(runCatchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Monthly billing catch-up failed: bookmark read failed');
  });
});

describe('8:00 AM ET monthly billing tick', () => {
  test('runs today\'s billing through runMonthlyBillingTick under the billing-monthly lock', async () => {
    await tick('0 8 * * *', 'runMonthlyBillingTick')();
    expect(runExclusive).toHaveBeenCalledWith('billing-monthly', expect.any(Function));
    expect(catchUp.runMonthlyBillingTick).toHaveBeenCalledTimes(1);
    expect(catchUp.catchUpNeeded).not.toHaveBeenCalled();
    expect(BillingCron.processMonthlyBilling).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Monthly billing done: 2 charged, 0 processing, 1 failed, 4 skipped');
  });
});
