// scripts/route-order-cleanup.js — the route-order-cleanup script's pure
// helpers: date-range bounding/validation, backup-file row flattening, and
// the rollback compare-and-swap (a row that moved again since the backup is
// reported, never blindly overwritten). main() itself (dotenv, real db,
// runRouteReorder, runExclusive) is exercised only through require.main's
// guard — see the recurring-series-topup.js precedent this mirrors.
jest.mock('../models/db', () => ({
  destroy: jest.fn(),
  transaction: jest.fn(),
}));

const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { buildDateRange, buildBackupRows, applyRollback } = require('../../scripts/route-order-cleanup');

const deps = { addETDays, etDateString, parseETDateTime };

describe('buildDateRange', () => {
  test('inclusive list of ET calendar dates from..to', () => {
    expect(buildDateRange('2026-10-01', '2026-10-04', deps)).toEqual({
      dates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
    });
  });

  test('a single-day range is one entry', () => {
    expect(buildDateRange('2026-10-01', '2026-10-01', deps)).toEqual({ dates: ['2026-10-01'] });
  });

  test('from after to is an error, not an empty/reversed range', () => {
    expect(buildDateRange('2026-10-05', '2026-10-01', deps).error).toMatch(/must not be after/);
  });

  test('a span over 60 days is refused rather than silently truncated', () => {
    const to = etDateString(addETDays(parseETDateTime('2026-10-01T00:00'), 70));
    expect(buildDateRange('2026-10-01', to, deps).error).toMatch(/more than 60 days/);
  });
});

describe('buildBackupRows', () => {
  test('flattens every entry\'s route_order_changes into per-row backup entries', () => {
    const entries = [
      { date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }, { id: 'b', before: null, after: 2 }] },
      { date: '2026-10-06', technicianId: 't2', route_order_changes: [] },
      { date: '2026-10-07', technicianId: 't1', skipped_reason: 'WITHIN_72H' }, // no route_order_changes field at all
    ];
    expect(buildBackupRows(entries)).toEqual([
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ]);
  });

  test('empty input produces an empty backup', () => {
    expect(buildBackupRows([])).toEqual([]);
    expect(buildBackupRows(undefined)).toEqual([]);
  });
});

describe('applyRollback', () => {
  function fakeTrx(updateResults) {
    const calls = [];
    return {
      calls,
      trx: (table) => ({
        where: (filter) => ({
          update: async (patch) => {
            calls.push({ table, filter, patch });
            const key = `${filter.id}:${filter.route_order}`;
            return updateResults[key] ?? 0;
          },
        }),
      }),
    };
  }

  test('restores every row whose CURRENT route_order still matches the backed-up "after" value', async () => {
    const { trx, calls } = fakeTrx({ 'a:1': 1, 'b:2': 1 });
    const lockTechDays = jest.fn(async () => ['t1:2026-10-05']);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows);
    expect(result).toEqual({ restored: 2, mismatched: [] });
    // Locked BEFORE any write, one call, deduped/sorted by lockTechDays itself.
    expect(lockTechDays).toHaveBeenCalledWith(trx, [
      { techId: 't1', date: '2026-10-05' },
      { techId: 't1', date: '2026-10-05' },
    ]);
    expect(calls).toEqual([
      { table: 'scheduled_services', filter: { id: 'a', route_order: 1 }, patch: { route_order: 2 } },
      { table: 'scheduled_services', filter: { id: 'b', route_order: 2 }, patch: { route_order: null } },
    ]);
  });

  test('a row whose route_order no longer matches "after" is reported, not overwritten', async () => {
    // 'a' updates fine; 'b' was moved again since the backup (its CURRENT
    // route_order is not what the backup's "after" says), so the CAS
    // WHERE clause matches nothing and the update returns 0.
    const { trx } = fakeTrx({ 'a:1': 1 });
    const lockTechDays = jest.fn(async () => []);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: 3, after: 2 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows);
    expect(result).toEqual({ restored: 1, mismatched: [{ id: 'b', expected_after: 2 }] });
  });

  test('an empty backup takes no lock and touches nothing', async () => {
    const lockTechDays = jest.fn();
    const result = await applyRollback({}, lockTechDays, []);
    expect(result).toEqual({ restored: 0, mismatched: [] });
    expect(lockTechDays).not.toHaveBeenCalled();
  });
});
