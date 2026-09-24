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

// A per-series savepoint under the outer trx — a distinct object from
// mockTrx so a test can tell "ran under the outer transaction directly" vs
// "ran under its own nested savepoint" apart if it needs to.
const mockSavepointTrx = { isTransaction: true };
const mockTrx = {
  rollback: jest.fn().mockResolvedValue(undefined),
  isTransaction: true,
  // knex's trx.transaction(cb) on an existing transaction opens a SAVEPOINT
  // and hands the callback that nested transaction object; the mock just
  // invokes the callback synchronously with mockSavepointTrx and returns
  // its result (a promise), same shape a real nested transaction's own
  // resolve/reject would have.
  transaction: jest.fn((cb) => cb(mockSavepointTrx)),
};
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

  test('given an outer `conn`, nests as a savepoint on it instead of opening its own transaction (Codex GitHub r3 P2)', async () => {
    mockTopUpRecurringSeriesWithLocks.mockResolvedValue({ spawnedVisits: [{ scheduledDate: '2027-01-01' }], skipped: null });
    const result = await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: true, conn: mockTrx });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockTrx.transaction).toHaveBeenCalledTimes(1);
    expect(mockTopUpRecurringSeriesWithLocks).toHaveBeenCalledWith(mockSavepointTrx, 'parent-1', { horizonDays: 90 });
    expect(mockTrx.rollback).not.toHaveBeenCalled(); // the OUTER trx's rollback is the caller's responsibility, not this series'
    expect(result.spawnedVisits).toHaveLength(1);
  });

  test('apply mode with an outer `conn` still routes through the committing wrapper, using that conn', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [], skipped: null });
    await topUpOneSeries('parent-1', { horizonDays: 90, dryRun: false, conn: mockTrx });
    expect(mockTopUpRecurringSeries).toHaveBeenCalledWith(mockTrx, 'parent-1', { horizonDays: 90 });
    expect(mockTrx.transaction).not.toHaveBeenCalled();
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
    // ONE outer transaction for the whole sweep, not one per series — p2's
    // savepoint failure must not have unwound the outer transaction or
    // stopped p3 from running under it.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockTrx.transaction).toHaveBeenCalledTimes(3);
  });

  test('nests each series as its own savepoint on ONE outer, rollback-only transaction (Codex GitHub r3 P2)', async () => {
    mockTopUpRecurringSeriesWithLocks.mockResolvedValue({ spawnedVisits: [], skipped: 'not_ongoing' });
    await runRecurringSeriesTopUpSweep({ dryRun: true, parentIds: ['p1', 'p2', 'p3'], horizonDays: 30 });
    // A per-series transaction (the old shape) would call db.transaction()
    // once per parentId; the fix calls it exactly once for the whole sweep
    // and nests each series under that same trx instead.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockTrx.transaction).toHaveBeenCalledTimes(3);
    expect(mockTopUpRecurringSeriesWithLocks).toHaveBeenCalledWith(mockSavepointTrx, 'p1', { horizonDays: 30 });
    // The outer transaction is rolled back with an explicit error exactly
    // once at the end — same after-commit-gate-closing contract as before,
    // now scoped to the whole sweep rather than each series.
    expect(mockTrx.rollback).toHaveBeenCalledTimes(1);
    expect(mockTrx.rollback.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('apply mode (dryRun: false) never opens a transaction of its own — topUpRecurringSeries manages its own per series', async () => {
    mockTopUpRecurringSeries.mockResolvedValue({ spawnedVisits: [], skipped: null });
    await runRecurringSeriesTopUpSweep({ dryRun: false, parentIds: ['p1', 'p2'] });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockTrx.transaction).not.toHaveBeenCalled();
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
