/**
 * services/recurring-series-topup.js — the nightly sweep wrapper.
 *
 * Pins the contract the gate-off SHADOW pass and the ops script's dry-run
 * mode both depend on: a dry run calls topUpRecurringSeriesWithLocks (same
 * maintenance lock + comms fence as a real run) inside a
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
const mockTopUpRecurringSeriesWithLocks = jest.fn();
jest.mock('../routes/admin-schedule', () => ({
  topUpRecurringSeries: (...args) => mockTopUpRecurringSeries(...args),
  topUpRecurringSeriesWithLocks: (...args) => mockTopUpRecurringSeriesWithLocks(...args),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  topUpOneSeries, runRecurringSeriesTopUpSweep, eligibleSeriesParentIds, horizonDaysFromEnv, DEFAULT_HORIZON_DAYS,
} = require('../services/recurring-series-topup');

describe('topUpOneSeries — dry run never reaches the committing wrapper', () => {
  beforeEach(() => jest.clearAllMocks());

  test('dryRun opens its own transaction, calls the lock-taking function, and always rolls back', async () => {
    mockTopUpRecurringSeriesWithLocks.mockResolvedValue({ spawnedVisits: [{ scheduledDate: '2027-01-01' }], skipped: null });
    const result = await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: true });
    expect(db.transaction).toHaveBeenCalledWith(); // no callback — manual commit/rollback form
    expect(mockTopUpRecurringSeriesWithLocks).toHaveBeenCalledWith(mockTrx, 'parent-1', { horizonDays: 90 });
    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    // Rolled back with an EXPLICIT error, not a bare rollback() — knex's
    // default doNotRejectOnRollback resolves (rather than rejects) the
    // transaction's completion promise on a bare rollback, which would let
    // an after-commit-gated side effect (annual-prepay-renewals.js's
    // fileCoverageExceptionAfterCommit, reached from the extend step) fire
    // for real on a dry run that wrote nothing.
    expect(mockTrx.rollback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
    expect(result.spawnedVisits).toHaveLength(1);
  });

  test('dryRun still rolls back even when the locked function throws', async () => {
    mockTopUpRecurringSeriesWithLocks.mockRejectedValue(new Error('boom'));
    await expect(topUpOneSeries('parent-1', { horizonDays: 90, dryRun: true })).rejects.toThrow('boom');
    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
  });

  test('apply mode calls the COMMITTING wrapper directly against the plain db — no manual transaction', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [], skipped: null });
    await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: false });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledWith(db, 'parent-1', { horizonDays: 90 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockTopUpRecurringSeriesWithLocks).not.toHaveBeenCalled();
  });

  test('an outer `conn` is not accepted any more — apply mode always calls the committing wrapper with plain db (Codex GitHub r4 P2)', async () => {
    // A `conn` passthrough briefly existed here and was removed: nothing in
    // this codebase ever called it, and the apply branch specifically would
    // have self-deadlocked (registerSpawnedVisitReminder inserts through a
    // FRESH connection with a foreign key to a scheduled_services row the
    // caller's own still-open transaction had inserted but not committed,
    // while that caller synchronously awaited this call before committing).
    // A stray `conn` in the options object is simply ignored now.
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [], skipped: null });
    await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: false, conn: mockTrx });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledWith(db, 'parent-1', { horizonDays: 90 });
  });
});

describe('runRecurringSeriesTopUpSweep', () => {
  beforeEach(() => jest.clearAllMocks());

  test('isolates a per-series failure — one bad series does not stop the run', async () => {
    mockTopUpRecurringSeriesWithLocks
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
    expect(mockTopUpRecurringSeriesWithLocks).toHaveBeenCalledTimes(3);
    // Never touched the committing wrapper in shadow mode.
    expect(mockTopUpRecurringSeries).not.toHaveBeenCalled();
    // Each series gets its OWN transaction (never one shared across the
    // sweep — see topUpOneSeries' comment on why): p2's failed transaction
    // must not have prevented p3 from opening and running its own.
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(mockTrx.rollback).toHaveBeenCalledTimes(3);
  });

  test('with no parentIds given, scans eligibleSeriesParentIds', async () => {
    mockPluck.mockResolvedValueOnce(['auto-1', 'auto-2']);
    mockTopUpRecurringSeriesWithLocks.mockResolvedValue({ spawnedVisits: [], skipped: 'not_ongoing' });
    const summary = await runRecurringSeriesTopUpSweep({ dryRun: true });
    expect(summary.scanned).toBe(2);
    expect(mockTopUpRecurringSeriesWithLocks).toHaveBeenCalledTimes(2);
  });

  test('apply mode (dryRun: false) routes every series through the committing wrapper', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [{ scheduledDate: '2027-02-02' }], skipped: null });
    const summary = await runRecurringSeriesTopUpSweep({ dryRun: false, parentIds: ['p1'] });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeriesWithLocks).not.toHaveBeenCalled();
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
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { process.env.RECURRING_TOPUP_HORIZON_DAYS = ORIGINAL; });

  test('defaults to 365 when unset', () => {
    delete process.env.RECURRING_TOPUP_HORIZON_DAYS;
    expect(horizonDaysFromEnv()).toBe(DEFAULT_HORIZON_DAYS);
    expect(DEFAULT_HORIZON_DAYS).toBe(365);
    expect(logger.warn).not.toHaveBeenCalled(); // unset is not an invalid value — nothing to warn about
  });

  // Codex GitHub r4 P2: an invalid value falls back to the default with a
  // logger.warn (the cron reads this on every run and must never crash
  // over a bad env value), never a silent Math.floor of something that was
  // never a clean integer in the first place.
  test.each([
    ['not-a-number'],
    ['-5'],
    ['0'],
    ['1.5'], // a fractional value is invalid outright now, never floored
    ['731'], // one past the 730 ceiling
    ['99999'],
  ])('falls back to 365 and warns on an invalid value %s', (value) => {
    process.env.RECURRING_TOPUP_HORIZON_DAYS = value;
    expect(horizonDaysFromEnv()).toBe(365);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(value);
  });

  test('honors a valid positive integer override', () => {
    process.env.RECURRING_TOPUP_HORIZON_DAYS = '180';
    expect(horizonDaysFromEnv()).toBe(180);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('honors the boundary values 1 and 730', () => {
    process.env.RECURRING_TOPUP_HORIZON_DAYS = '1';
    expect(horizonDaysFromEnv()).toBe(1);
    process.env.RECURRING_TOPUP_HORIZON_DAYS = '730';
    expect(horizonDaysFromEnv()).toBe(730);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
