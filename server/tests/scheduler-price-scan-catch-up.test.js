/**
 * Weekly price scan crons (server/services/scheduler.js): the Monday tick and the hourly
 * catch-up rerun. A failed scan (interrupted / degraded) throws inside the lock so job_health
 * records 'failed'; a clean skip does not. The catch-up reads the job_health row and reruns
 * only when the pure decision says so, behind the same gate.
 *
 * Mock baseline copied from scheduler-alert-retention-cron.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn(),
}));
let mockHealthRow = null;
let mockHealthRowQueue = []; // consumed first, one per read, before mockHealthRow
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where() { return this; }, first: jest.fn(async () => (mockHealthRowQueue.length ? mockHealthRowQueue.shift() : mockHealthRow)), del: jest.fn().mockResolvedValue(0) }));
  db.raw = jest.fn().mockResolvedValue({ rows: [] });
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  recurringSeriesTopUpLive: jest.fn(() => false), alertRetentionMode: jest.fn(() => 'off'),
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

// Keep the real throwIfScanFailed: it is the contract under test.
jest.mock('../services/price-scan/weekly-scan', () => ({
  ...jest.requireActual('../services/price-scan/weekly-scan'),
  runWeeklyScan: jest.fn(),
}));

const cron = require('../utils/scheduled-cron');
const { runExclusive } = require('../utils/cron-lock');
const { isEnabled } = require('../config/feature-gates');
const { runWeeklyScan } = require('../services/price-scan/weekly-scan');
const logger = require('../services/logger');
const { initScheduledJobs } = require('../services/scheduler');

function registerCrons(gates = ['cronJobs', 'priceScanWeekly']) {
  isEnabled.mockImplementation((name) => gates.includes(name));
  initScheduledJobs();
  const weekly = cron.schedule.mock.calls.filter(([expression]) => expression === '0 6 * * 1');
  const catchUp = cron.schedule.mock.calls.filter(([expression, fn]) => expression === '20 * * * *' && String(fn).includes('decidePriceScanCatchUp'));
  expect(weekly).toHaveLength(1);
  expect(catchUp).toHaveLength(1);
  expect(weekly[0][2]).toEqual({ timezone: 'America/New_York' });
  expect(catchUp[0][2]).toEqual({ timezone: 'America/New_York' });
  return { weekly: weekly[0][1], catchUp: catchUp[0][1] };
}

const ago = (ms) => new Date(Date.now() - ms);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  jest.clearAllMocks();
  mockHealthRow = null;
  mockHealthRowQueue = [];
  runExclusive.mockImplementation(async (_key, task) => task());
});

describe('the Monday tick', () => {
  test('a healthy scan records no failure', async () => {
    runWeeklyScan.mockResolvedValue({ ok: true, evaluated: 25, scanned: 25, draftId: 12 });
    const { weekly } = registerCrons();
    await weekly();
    expect(runExclusive).toHaveBeenCalledWith('price-scan-weekly', expect.any(Function));
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each([
    ['interrupted', { signal: 'SIGTERM', evaluated: 25, fetchFailed: 24, scanned: 25 }],
    ['degraded', { evaluated: 25, fetchFailed: 20, scanned: 25 }],
    ['scan_error', { evaluated: 25, error: 'boom' }],
  ])('a %s scan throws inside the lock so job_health records failed', async (reason, extra) => {
    runWeeklyScan.mockResolvedValue({ ok: false, reason, ...extra });
    const { weekly } = registerCrons();
    let thrown = null;
    runExclusive.mockImplementationOnce(async (_key, task) => { try { return await task(); } catch (e) { thrown = e; throw e; } });
    await expect(weekly()).resolves.toBeUndefined(); // the tick itself logs, never throws
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(new RegExp(`^price scan ${reason}: `));
    expect(thrown.message).toMatch(/25 products evaluated/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`price scan ${reason}`));
  });

  test.each(['browser_unavailable', 'vendors_missing', 'no_scrapable_vendors'])('%s stays a clean skip (no throw)', async (reason) => {
    runWeeklyScan.mockResolvedValue({ ok: false, reason, evaluated: 0 });
    const { weekly } = registerCrons();
    await weekly();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('gate off: the tick returns before the lock', async () => {
    const { weekly } = registerCrons(['cronJobs']);
    await weekly();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runWeeklyScan).not.toHaveBeenCalled();
  });
});

describe('the hourly catch-up tick', () => {
  test('gate off: nothing is read or run', async () => {
    mockHealthRow = { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 1 };
    const { catchUp } = registerCrons(['cronJobs']);
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runWeeklyScan).not.toHaveBeenCalled();
  });

  test('a recent failed run is rerun under the same lock name', async () => {
    mockHealthRow = { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 1 };
    runWeeklyScan.mockResolvedValue({ ok: true, evaluated: 25, scanned: 25 });
    const { catchUp } = registerCrons();
    await catchUp();
    expect(runExclusive).toHaveBeenCalledWith('price-scan-weekly-catch-up', expect.any(Function), { recordHealth: false });
    expect(runExclusive).toHaveBeenCalledWith('price-scan-weekly', expect.any(Function));
    expect(runWeeklyScan).toHaveBeenCalledTimes(1);
  });

  test('another instance finished the rerun while this tick waited for the lock: no second scan', async () => {
    const failed = { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 1 };
    const fixed = { last_status: 'success', last_started_at: ago(5 * 60 * 1000), last_finished_at: ago(60 * 1000), consecutive_failures: 0 };
    mockHealthRowQueue = [failed, fixed]; // cheap pre-check sees the failure; the read under the lock sees the fix
    const { catchUp } = registerCrons();
    await catchUp();
    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(runExclusive).toHaveBeenCalledWith('price-scan-weekly-catch-up', expect.any(Function), { recordHealth: false });
    expect(runWeeklyScan).not.toHaveBeenCalled();
  });

  test('a rerun that fails again throws inside the lock (the failure count climbs)', async () => {
    mockHealthRow = { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 1 };
    runWeeklyScan.mockResolvedValue({ ok: false, reason: 'degraded', evaluated: 25, fetchFailed: 25 });
    const { catchUp } = registerCrons();
    await expect(catchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Price scan catch-up failed: price scan degraded'));
  });

  test('a stalled running row is rerun', async () => {
    mockHealthRow = { last_status: 'running', last_started_at: ago(4 * HOUR), last_finished_at: null, consecutive_failures: 0 };
    runWeeklyScan.mockResolvedValue({ ok: true, evaluated: 25 });
    const { catchUp } = registerCrons();
    await catchUp();
    expect(runWeeklyScan).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a success', { last_status: 'success', last_started_at: ago(2 * HOUR), consecutive_failures: 0 }],
    ['a normal run in flight', { last_status: 'running', last_started_at: ago(HOUR), consecutive_failures: 0 }],
    ['a failure older than a day', { last_status: 'failed', last_started_at: ago(30 * HOUR), last_finished_at: ago(29 * HOUR), consecutive_failures: 1 }],
    ['four failures in a row', { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 4 }],
    ['no row', null],
  ])('does nothing for %s', async (_label, row) => {
    mockHealthRow = row;
    const { catchUp } = registerCrons();
    await catchUp();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runWeeklyScan).not.toHaveBeenCalled();
  });

  test('a lock another instance holds skips quietly', async () => {
    mockHealthRow = { last_status: 'failed', last_started_at: ago(2 * HOUR), last_finished_at: ago(HOUR), consecutive_failures: 1 };
    runExclusive.mockImplementationOnce(async () => ({ skipped: true, reason: 'lease_held' }));
    const { catchUp } = registerCrons();
    await catchUp();
    expect(runWeeklyScan).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('an unreadable job_health row is logged, never thrown', async () => {
    const db = require('../models/db');
    const { catchUp } = registerCrons();
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(catchUp()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Price scan catch-up failed: db down');
  });
});
