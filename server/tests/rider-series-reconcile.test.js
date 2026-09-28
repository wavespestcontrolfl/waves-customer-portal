/**
 * services/rider-series-reconcile.js — the nightly rider-series sweep.
 *
 * Pins the job-health contract (P2 fix #8): a per-rider `skipped: 'error'`
 * result must count toward summary.errors, not summary.skipped, or a run
 * where every rider genuinely failed still reads as a healthy "skipped: N"
 * to whatever watches this summary. Every other skip reason stays a skip.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockPluck = jest.fn().mockResolvedValue([]);
const mockColumnInfo = jest.fn().mockResolvedValue({ rides_parent_id: {} });
jest.mock('../models/db', () => {
  const tableFn = jest.fn(() => ({
    whereNotNull: jest.fn().mockReturnThis(),
    columnInfo: mockColumnInfo,
    pluck: mockPluck,
  }));
  return tableFn;
});

const mockSyncRiderSeries = jest.fn();
jest.mock('../services/rider-series', () => ({
  syncRiderSeries: (...args) => mockSyncRiderSeries(...args),
}));

const { runRiderSeriesReconcileSweep } = require('../services/rider-series-reconcile');

describe('rider-series-reconcile summary counting', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a per-rider skipped: "error" counts in summary.errors, not summary.skipped (fail-without-fix evidence)', async () => {
    mockSyncRiderSeries
      .mockResolvedValueOnce({ skipped: 'error' })
      .mockResolvedValueOnce({ skipped: 'error' });

    const summary = await runRiderSeriesReconcileSweep({ parentIds: ['a', 'b'] });

    expect(summary.errors).toHaveLength(2);
    expect(summary.errors.map((e) => e.parentId)).toEqual(['a', 'b']);
    expect(summary.skipped.error).toBeUndefined();
    expect(summary.synced).toBe(0);
    // Without the fix this run reads as fully healthy — 0 errors, 2 quiet
    // "skipped: error" entries — which is exactly the false-healthy shape
    // the fix exists to prevent.
  });

  test('other skip reasons still count in summary.skipped, not summary.errors', async () => {
    mockSyncRiderSeries
      .mockResolvedValueOnce({ skipped: 'not_ongoing' })
      .mockResolvedValueOnce({ skipped: 'host_locked' })
      .mockResolvedValueOnce({ skipped: 'not_ongoing' });

    const summary = await runRiderSeriesReconcileSweep({ parentIds: ['a', 'b', 'c'] });

    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual({ not_ongoing: 2, host_locked: 1 });
    expect(summary.synced).toBe(0);
  });

  test('a mix of synced, skipped and errored riders lands in the right bucket', async () => {
    mockSyncRiderSeries
      .mockResolvedValueOnce({ skipped: undefined, insertedRows: [] })
      .mockResolvedValueOnce({ skipped: 'error' })
      .mockResolvedValueOnce({ skipped: 'customer_locked' });

    const summary = await runRiderSeriesReconcileSweep({ parentIds: ['a', 'b', 'c'] });

    expect(summary.synced).toBe(1);
    expect(summary.errors).toEqual([{ parentId: 'b', error: expect.any(String) }]);
    expect(summary.skipped).toEqual({ customer_locked: 1 });
  });

  test('a thrown exception from syncRiderSeries still lands in summary.errors with the real message', async () => {
    mockSyncRiderSeries.mockRejectedValueOnce(new Error('db exploded'));

    const summary = await runRiderSeriesReconcileSweep({ parentIds: ['a'] });

    expect(summary.errors).toEqual([{ parentId: 'a', error: 'db exploded' }]);
    expect(summary.skipped).toEqual({});
  });
});
