/**
 * services/recurring-series-topup.js — the nightly sweep wrapper.
 *
 * Pins the contract the gate-off SHADOW pass and the ops script's dry-run
 * mode both depend on: a dry run calls topUpRecurringSeriesLocked inside a
 * transaction this module opens and ALWAYS rolls back, and never calls the
 * committing wrapper (topUpRecurringSeries) — so a dry/shadow run can never
 * write, regardless of what the locked function itself does. Also pins
 * per-series failure isolation (one bad series must not stop the sweep).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockTrx = { rollback: jest.fn().mockResolvedValue(undefined), isTransaction: true };
const mockTransaction = jest.fn().mockResolvedValue(mockTrx);
const mockPluck = jest.fn().mockResolvedValue([]);
const mockColumnInfo = jest.fn().mockResolvedValue({ recurring_ongoing: {} });

jest.mock('../models/db', () => {
  const tableFn = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    columnInfo: mockColumnInfo,
    pluck: mockPluck,
  }));
  tableFn.transaction = mockTransaction;
  return tableFn;
});

const mockTopUpRecurringSeries = jest.fn();
const mockTopUpRecurringSeriesLocked = jest.fn();
jest.mock('../routes/admin-schedule', () => ({
  topUpRecurringSeries: (...args) => mockTopUpRecurringSeries(...args),
  topUpRecurringSeriesLocked: (...args) => mockTopUpRecurringSeriesLocked(...args),
}));

const db = require('../models/db');
const {
  topUpOneSeries, runRecurringSeriesTopUpSweep, eligibleSeriesParentIds, horizonDaysFromEnv, DEFAULT_HORIZON_DAYS,
} = require('../services/recurring-series-topup');

describe('topUpOneSeries — dry run never reaches the committing wrapper', () => {
  beforeEach(() => jest.clearAllMocks());

  test('dryRun opens its own transaction, calls the LOCKED function, and always rolls back', async () => {
    mockTopUpRecurringSeriesLocked.mockResolvedValue({ spawnedVisits: [{ scheduledDate: '2027-01-01' }], skipped: null });
    const result = await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: true });
    expect(db.transaction).toHaveBeenCalledWith(); // no callback — manual commit/rollback form
    expect(mockTopUpRecurringSeriesLocked).toHaveBeenCalledWith(mockTrx, 'parent-1', { horizonDays: 90 });
    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
    expect(result.spawnedVisits).toHaveLength(1);
  });

  test('dryRun still rolls back even when the locked function throws', async () => {
    mockTopUpRecurringSeriesLocked.mockRejectedValue(new Error('boom'));
    await expect(topUpOneSeries('parent-1', { horizonDays: 90, dryRun: true })).rejects.toThrow('boom');
    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
  });

  test('apply mode calls the COMMITTING wrapper directly against the plain db — no manual transaction', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [], skipped: null });
    await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: false });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledWith(db, 'parent-1', { horizonDays: 90 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockTopUpRecurringSeriesLocked).not.toHaveBeenCalled();
  });
});

describe('runRecurringSeriesTopUpSweep', () => {
  beforeEach(() => jest.clearAllMocks());

  test('isolates a per-series failure — one bad series does not stop the run', async () => {
    mockTopUpRecurringSeriesLocked
      .mockResolvedValueOnce({ spawnedVisits: [{ scheduledDate: '2027-01-01' }], skipped: null })
      .mockRejectedValueOnce(new Error('series exploded'))
      .mockResolvedValueOnce({ spawnedVisits: [], skipped: 'not_ongoing' });

    const summary = await runRecurringSeriesTopUpSweep({
      dryRun: true, parentIds: ['p1', 'p2', 'p3'], horizonDays: 30,
    });

    expect(summary.scanned).toBe(3);
    expect(summary.toppedUp).toBe(1);
    expect(summary.visitsInserted).toBe(1);
    expect(summary.skipped).toEqual({ not_ongoing: 1 });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].parentId).toBe('p2');
    // The failing series must not have prevented p3 from running.
    expect(mockTopUpRecurringSeriesLocked).toHaveBeenCalledTimes(3);
    // Never touched the committing wrapper in shadow mode.
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
  });

  test('with no parentIds given, scans eligibleSeriesParentIds', async () => {
    mockPluck.mockResolvedValueOnce(['auto-1', 'auto-2']);
    mockTopUpRecurringSeriesLocked.mockResolvedValue({ spawnedVisits: [], skipped: 'not_ongoing' });
    const summary = await runRecurringSeriesTopUpSweep({ dryRun: true });
    expect(summary.scanned).toBe(2);
    expect(mockTopUpRecurringSeriesLocked).toHaveBeenCalledTimes(2);
  });

  test('apply mode (dryRun: false) routes every series through the committing wrapper', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [{ scheduledDate: '2027-02-02' }], skipped: null });
    const summary = await runRecurringSeriesTopUpSweep({ dryRun: false, parentIds: ['p1'] });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeriesLocked).not.toHaveBeenCalled();
    expect(summary.toppedUp).toBe(1);
    expect(summary.visitsInserted).toBe(1);
  });
});

describe('eligibleSeriesParentIds', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns [] when the schema predates recurring_ongoing', async () => {
    mockColumnInfo.mockResolvedValueOnce({});
    const ids = await eligibleSeriesParentIds(db);
    expect(ids).toEqual([]);
    expect(mockPluck).not.toHaveBeenCalled();
  });
});

describe('horizonDaysFromEnv', () => {
  const ORIGINAL = process.env.RECURRING_TOPUP_HORIZON_DAYS;
  afterEach(() => { process.env.RECURRING_TOPUP_HORIZON_DAYS = ORIGINAL; });

  test('defaults to 365 when unset or invalid', () => {
    delete process.env.RECURRING_TOPUP_HORIZON_DAYS;
    expect(horizonDaysFromEnv()).toBe(DEFAULT_HORIZON_DAYS);
    expect(DEFAULT_HORIZON_DAYS).toBe(365);
    process.env.RECURRING_TOPUP_HORIZON_DAYS = 'not-a-number';
    expect(horizonDaysFromEnv()).toBe(365);
    process.env.RECURRING_TOPUP_HORIZON_DAYS = '-5';
    expect(horizonDaysFromEnv()).toBe(365);
  });

  test('honors a valid positive override', () => {
    process.env.RECURRING_TOPUP_HORIZON_DAYS = '180';
    expect(horizonDaysFromEnv()).toBe(180);
  });
});
