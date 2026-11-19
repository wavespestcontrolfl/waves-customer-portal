/**
 * Day re-plan shadow job in its own 4:40 AM ET cron (server/services/scheduler.js, '40 4 * * *', GATE_DAY_REPLAN):
 * registered once after the 4:20 reorder pass; gate off returns before any lock or read; on, it runs under
 * 'day-replan-nightly' nested inside the 4:10 writer lock ('auto-dispatch-recurring', no health row of its own),
 * and any run that is not clean is logged, never thrown out of the tick.
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
  recurringSeriesTopUpLive: jest.fn(() => false), dayReplanMode: jest.fn(() => 'off'),
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

jest.mock('../services/day-replan', () => ({ runDayReplanIfEnabled: jest.fn() }));
jest.mock('../services/day-replan/open-blocks-alert', () => ({ runOpenBlocksAlert: jest.fn() }));
jest.mock('../services/day-replan/route-check', () => ({ runRouteCheck: jest.fn() }));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled, dayReplanMode } = require('../config/feature-gates');
const { runDayReplanIfEnabled } = require('../services/day-replan');
const { runOpenBlocksAlert } = require('../services/day-replan/open-blocks-alert');
const { runRouteCheck } = require('../services/day-replan/route-check');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function registration() {
  isEnabled.mockImplementation((name) => name === 'cronJobs');
  initScheduledJobs();
  // Other jobs also run at 4:40, so the job is identified by its lock name.
  const found = cron.schedule.mock.calls.filter(([expression, task]) => expression === '40 4 * * *' && String(task).includes("'day-replan-nightly'"));
  expect(found).toHaveLength(1);
  return found[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  dayReplanMode.mockReturnValue('off');
  runDayReplanIfEnabled.mockResolvedValue({ status: 'completed', days: 1, failed: [] });
});

test('registered once at 4:40 AM Eastern, after the 4:20 reorder pass', () => {
  const [expression, , options] = registration();
  expect(expression).toBe('40 4 * * *');
  expect(options).toEqual({ timezone: 'America/New_York' });
  const expressions = cron.schedule.mock.calls.map(([e]) => e);
  expect(expressions).toContain('20 4 * * *');
});

test('gate off: the tick returns before the lock or any read', async () => {
  await registration()[1]();
  expect(runExclusive).not.toHaveBeenCalledWith('day-replan-nightly', expect.any(Function));
  expect(runDayReplanIfEnabled).not.toHaveBeenCalled();
});

test.each(['shadow', 'apply'])('gate %s: runs under day-replan-nightly, nested in the night writer lock', async (mode) => {
  dayReplanMode.mockReturnValue(mode);
  await registration()[1]();
  expect(runExclusive.mock.calls.map(([name]) => name)).toEqual(['day-replan-nightly', 'auto-dispatch-recurring']);
  expect(runExclusive.mock.calls[1][2]).toEqual({ recordHealth: false, waitForLockMs: 25 * 60 * 1000 });
  expect(runDayReplanIfEnabled).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});

test('the inner writer-lock call waits up to 25 minutes; the outer lock does not', async () => {
  dayReplanMode.mockReturnValue('shadow');
  await registration()[1]();
  expect(runExclusive.mock.calls[0][2]).toBeUndefined();
  expect(runExclusive.mock.calls[1][2]).toEqual({ recordHealth: false, waitForLockMs: 25 * 60 * 1000 });
});

test('a run that is not clean is logged, never thrown out of the tick', async () => {
  dayReplanMode.mockReturnValue('shadow');
  runDayReplanIfEnabled.mockResolvedValueOnce({ status: 'completed_with_errors', failed: [{ date: '2026-11-04' }] });
  await expect(registration()[1]()).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('day-replan run unhealthy: status=completed_with_errors'));
});

test('a held writer lock fails the tick loudly instead of passing as a run', async () => {
  dayReplanMode.mockReturnValue('shadow');
  runExclusive.mockImplementation(async (name, task) => (name === 'auto-dispatch-recurring' ? { skipped: true, reason: 'lease_held' } : task()));
  await registration()[1]();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('the run lock was held'));
  runExclusive.mockImplementation(async (_key, task) => task());
});

describe('07:05 open blocks to sell (owner 2026-11-18): reads the re-plan numbers, raises one admin row', () => {
  function openBlocksJob() {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    initScheduledJobs();
    const found = cron.schedule.mock.calls.filter(([, task]) => String(task).includes("'open-blocks-alert'"));
    expect(found).toHaveLength(1);
    return found[0];
  }

  test('registered once at 7:05 AM Eastern; runs under its own health lock with no gate', async () => {
    const [expression, task, options] = openBlocksJob();
    expect(expression).toBe('5 7 * * *');
    expect(options).toEqual({ timezone: 'America/New_York' });
    runOpenBlocksAlert.mockResolvedValueOnce({ status: 'raised', openMin: 325 });
    await task();
    expect(runExclusive.mock.calls.map(([name]) => name)).toEqual(['open-blocks-alert']);
    expect(runOpenBlocksAlert).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('[open-blocks] raised openMin=325');
  });

  test('a failure is logged, never thrown out of the tick', async () => {
    runOpenBlocksAlert.mockRejectedValueOnce(new Error('db down'));
    await expect(openBlocksJob()[1]()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[open-blocks] tick failed: db down');
  });
});

describe('hourly route check, shadow (owner 2026-11-19): measures the openings, writes only its own log', () => {
  function routeCheckJob() {
    isEnabled.mockImplementation((name) => name === 'cronJobs');
    initScheduledJobs();
    const found = cron.schedule.mock.calls.filter(([, task]) => String(task).includes("'route-check'"));
    expect(found).toHaveLength(1);
    return found[0];
  }

  test('registered once, every hour 7:30 AM to 7:30 PM Eastern, under its own health lock with no gate', async () => {
    const [expression, task, options] = routeCheckJob();
    expect(expression).toBe('30 7-19 * * *');
    expect(options).toEqual({ timezone: 'America/New_York' });
    runRouteCheck.mockResolvedValueOnce({ status: 'completed', totals: { next: { slots: 2 } } });
    await task();
    expect(runExclusive.mock.calls.map(([name]) => name)).toEqual(['route-check']);
    expect(logger.info).toHaveBeenCalledWith('[route-check] completed slots=2');
  });

  test('a failure is logged, never thrown out of the tick', async () => {
    runRouteCheck.mockRejectedValueOnce(new Error('db down'));
    await expect(routeCheckJob()[1]()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('[route-check] tick failed: db down');
  });

  test("a second instance's run of an hour already recorded ('duplicate') is no failure", async () => {
    runRouteCheck.mockResolvedValueOnce({ status: 'duplicate', totals: { next: { slots: 2 } } });
    let lockOutcome;
    runExclusive.mockImplementationOnce(async (_key, task) => {
      lockOutcome = task().then(() => 'ok', (err) => err.message);
      return lockOutcome;
    });
    await routeCheckJob()[1]();
    expect(await lockOutcome).toBe('ok');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each(['failed', 'completed_with_errors'])('a run recorded as %s still fails the health lock, and the tick does not throw', async (status) => {
    runRouteCheck.mockResolvedValueOnce({ status, totals: {} });
    let lockOutcome;
    runExclusive.mockImplementationOnce(async (_key, task) => {
      lockOutcome = task().then(() => 'ok', (err) => err.message);
      return lockOutcome.then((o) => { if (o !== 'ok') throw new Error(o); });
    });
    await expect(routeCheckJob()[1]()).resolves.toBeUndefined();
    expect(await lockOutcome).toBe(`route check ${status} (recorded)`);
    expect(logger.error).toHaveBeenCalledWith(`[route-check] tick failed: route check ${status} (recorded)`);
  });
});
