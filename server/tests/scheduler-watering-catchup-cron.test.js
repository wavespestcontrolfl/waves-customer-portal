/**
 * Monday catch-up ticks for the irrigation weekly email sweep in
 * server/services/scheduler.js (GATE_WATERING_CATCHUP, owner 2026-11-06).
 * Gate off: the tick does nothing at all. Gate on: it runs the sweep under the
 * 7:00 tick's own lock only when this week's sweep has not finished. The 7:00
 * tick is unchanged. The catch-up module is faked here; its decisions are
 * tested in irrigation-weekly-catchup.test.js.
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
  wateringCatchupLive: jest.fn(() => false),
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

jest.mock('../services/irrigation-weekly-catchup', () => ({
  sweepWeekIsMissing: jest.fn(),
  runWeeklyIrrigationEmailCatchUp: jest.fn().mockResolvedValue({ sent: 3 }),
}));
jest.mock('../services/irrigation-weekly-email', () => ({
  runWeeklyIrrigationEmailSweep: jest.fn().mockResolvedValue({ sent: 5 }),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, wateringCatchupLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const catchUp = require('../services/irrigation-weekly-catchup');
const { runWeeklyIrrigationEmailSweep } = require('../services/irrigation-weekly-email');
const { initScheduledJobs } = require('../services/scheduler');

let registrations = null;
function tick(expression, handlerSource) {
  if (!registrations) {
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
  wateringCatchupLive.mockReturnValue(false);
});

describe('irrigation weekly email catch-up (Monday 8:01, 9:01, 10:01, 11:01)', () => {
  const runCatchUp = () => tick('1 8-11 * * 1', 'runWeeklyIrrigationEmailCatchUp')();

  test('gate off: the tick returns before any check, lock or sweep', async () => {
    catchUp.sweepWeekIsMissing.mockResolvedValue(true);
    await runCatchUp();
    expect(catchUp.sweepWeekIsMissing).not.toHaveBeenCalled();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(catchUp.runWeeklyIrrigationEmailCatchUp).not.toHaveBeenCalled();
  });

  test('gate on, this week\'s sweep finished: no lock, no run', async () => {
    wateringCatchupLive.mockReturnValue(true);
    catchUp.sweepWeekIsMissing.mockResolvedValue(false);
    await runCatchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(catchUp.runWeeklyIrrigationEmailCatchUp).not.toHaveBeenCalled();
  });

  test('gate on, this week missing: runs under the 7:00 tick\'s own lock name', async () => {
    wateringCatchupLive.mockReturnValue(true);
    catchUp.sweepWeekIsMissing.mockResolvedValue(true);
    await runCatchUp();
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(runExclusive).toHaveBeenCalledWith('irrigation-weekly-email', expect.any(Function));
    expect(catchUp.runWeeklyIrrigationEmailCatchUp).toHaveBeenCalledTimes(1);
  });

  test('a 7:00 sweep still holding the lock: the catch-up body never runs', async () => {
    wateringCatchupLive.mockReturnValue(true);
    catchUp.sweepWeekIsMissing.mockResolvedValue(true);
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    await runCatchUp();
    expect(catchUp.runWeeklyIrrigationEmailCatchUp).not.toHaveBeenCalled();
  });

  test('a failed catch-up is logged, never thrown out of the tick', async () => {
    wateringCatchupLive.mockReturnValue(true);
    catchUp.sweepWeekIsMissing.mockResolvedValue(true);
    catchUp.runWeeklyIrrigationEmailCatchUp.mockRejectedValueOnce(new Error('boom'));
    await expect(runCatchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Weekly irrigation email catch-up failed: boom');
  });

  test('the Monday 7:00 tick is unchanged: plain sweep, no gate read, no pre-check', async () => {
    await tick('0 7 * * 1', 'runWeeklyIrrigationEmailSweep')();
    expect(wateringCatchupLive).not.toHaveBeenCalled();
    expect(catchUp.sweepWeekIsMissing).not.toHaveBeenCalled();
    expect(runExclusive).toHaveBeenCalledWith('irrigation-weekly-email', expect.any(Function));
    expect(runWeeklyIrrigationEmailSweep).toHaveBeenCalledWith();
  });
});
