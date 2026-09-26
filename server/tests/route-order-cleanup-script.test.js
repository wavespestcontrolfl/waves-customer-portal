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

const fs = require('fs');
const { addETDays, etDateString, parseETDateTime } = require('../utils/datetime-et');
const { wasLockSkipped } = require('../utils/cron-lock');
const {
  buildDateRange, buildBackupRows, applyRollback, parseLedgerResult, recoveryInstruction,
  collectEntries, reportAndBackup,
} = require('../../scripts/route-order-cleanup');

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
  // Keyed on the FULL CAS tuple (id, route_order, scheduled_date,
  // technician_id) — a fake DB that only matched id+route_order would hide
  // exactly the bug this rollback fixes (a row reassigned to a different
  // tech-day since the backup, coincidentally sharing the same route_order
  // number, silently overwritten instead of reported).
  function fakeTrx(updateResults) {
    const calls = [];
    return {
      calls,
      trx: (table) => ({
        where: (filter) => ({
          update: async (patch) => {
            calls.push({ table, filter, patch });
            const key = `${filter.id}:${filter.route_order}:${filter.scheduled_date}:${filter.technician_id}`;
            return updateResults[key] ?? 0;
          },
        }),
      }),
    };
  }

  test('restores every row whose CURRENT route_order, date AND technician still match the backup', async () => {
    const { trx, calls } = fakeTrx({ 'a:1:2026-10-05:t1': 1, 'b:2:2026-10-05:t1': 1 });
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
      { table: 'scheduled_services', filter: { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }, patch: { route_order: 2 } },
      { table: 'scheduled_services', filter: { id: 'b', route_order: 2, scheduled_date: '2026-10-05', technician_id: 't1' }, patch: { route_order: null } },
    ]);
  });

  test('a row whose route_order no longer matches "after" is reported, not overwritten', async () => {
    // 'a' updates fine; 'b' was moved again since the backup (its CURRENT
    // route_order is not what the backup's "after" says), so the CAS
    // WHERE clause matches nothing and the update returns 0.
    const { trx } = fakeTrx({ 'a:1:2026-10-05:t1': 1 });
    const lockTechDays = jest.fn(async () => []);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: 3, after: 2 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows);
    expect(result).toEqual({ restored: 1, mismatched: [{ id: 'b', expected_after: 2 }] });
  });

  test('a row moved to a DIFFERENT tech-day since the backup is reported, never overwritten, even with the same id + route_order', async () => {
    // The exact codex P1: a row backed up as tech t1's #1 on 10-05 is now
    // tech t2's #1 on 10-06 (a legitimate later reassignment) — id +
    // route_order alone would match it and clobber t2's #1 with t1's old
    // "before" value. The full CAS (date + technician_id too) must refuse.
    const updateResults = {}; // nothing matches the OLD tech-day/date tuple
    const { trx, calls } = fakeTrx(updateResults);
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(trx, lockTechDays, rows);
    expect(result).toEqual({ restored: 0, mismatched: [{ id: 'a', expected_after: 1 }] });
    expect(calls[0].filter).toEqual({ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' });
  });

  test('an empty backup takes no lock and touches nothing', async () => {
    const lockTechDays = jest.fn();
    const result = await applyRollback({}, lockTechDays, []);
    expect(result).toEqual({ restored: 0, mismatched: [] });
    expect(lockTechDays).not.toHaveBeenCalled();
  });
});

describe('parseLedgerResult', () => {
  test('route_optimization_planner_runs.result is jsonb — a real read-back hands back an OBJECT, never a string', () => {
    // This is the actual pg/knex shape after INSERT ... RETURNING or a
    // plain SELECT on a jsonb column: JSON.parse'ing it throws
    // ("[object Object]" is not valid JSON) — the exact codex P1 that
    // crashed --out AFTER the live writes had already committed.
    const obj = { reorders: [{ id: 'a' }], skips: [], failures: [] };
    expect(parseLedgerResult(obj)).toBe(obj);
  });

  test('a string is still parsed (defensive — some driver configs stringify jsonb)', () => {
    const obj = { reorders: [{ id: 'a' }] };
    expect(parseLedgerResult(JSON.stringify(obj))).toEqual(obj);
  });

  test('null/undefined is an empty object, never a throw', () => {
    expect(parseLedgerResult(null)).toEqual({});
    expect(parseLedgerResult(undefined)).toEqual({});
  });
});

describe('recoveryInstruction', () => {
  test('names the ledger id and points at route_order_changes for a manual rebuild', () => {
    const msg = recoveryInstruction('ledger-123');
    expect(msg).toMatch(/ledger id ledger-123/);
    expect(msg).toMatch(/route_order_changes/);
    expect(msg).toMatch(/ALREADY COMMITTED/);
  });

  test('still reads sensibly with no ledger id', () => {
    expect(recoveryInstruction(null)).toMatch(/ALREADY COMMITTED/);
  });
});

describe('lock-refusal detection (the script must use wasLockSkipped, not a bare .skipped truthiness check)', () => {
  // The exact regression: runRouteReorder's OWN successful return carries
  // `skipped` as a NUMBER (the count of skipped tech-days — routinely > 0
  // on a normal run with nothing else wrong), and its dry-run shape has no
  // `skipped` key at all. A naive `if (result.skipped)` reads either as
  // truthy/absent-but-safe in confusing ways; wasLockSkipped is the one
  // correct predicate — real shapes, both directions.
  test('a successful --execute run with skipped tech-days is NOT a lock refusal', () => {
    expect(wasLockSkipped({ status: 'completed', applied: 2, skipped: 5, failed: 0, ledgerId: 'x' })).toBe(false);
  });

  test('a successful dry run (no `skipped` key at all) is NOT a lock refusal', () => {
    expect(wasLockSkipped({ status: 'completed', plan: [] })).toBe(false);
  });

  test('the run reporting zero skips either way is NOT a lock refusal', () => {
    expect(wasLockSkipped({ status: 'completed', applied: 1, skipped: 0, failed: 0, ledgerId: 'x' })).toBe(false);
  });

  test('the MACHINERY skip shapes ARE a lock refusal', () => {
    expect(wasLockSkipped({ skipped: true, reason: 'lease_held' })).toBe(true);
    expect(wasLockSkipped({ skipped: true, reason: 'no_connection' })).toBe(true);
  });
});

describe('collectEntries', () => {
  test('dry run reads result.plan directly — no db call', async () => {
    const db = jest.fn(() => { throw new Error('db must not be touched in dry run'); });
    const result = { status: 'completed', plan: [{ date: '2026-10-05' }] };
    expect(await collectEntries(db, false, result)).toEqual({ entries: [{ date: '2026-10-05' }], error: null });
  });

  test('--execute reads the ledger row back — the REAL jsonb shape (an object, not a string)', async () => {
    const reorders = [{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }];
    const db = jest.fn((table) => {
      expect(table).toBe('route_optimization_planner_runs');
      return { where: () => ({ first: async () => ({ result: { reorders, skips: [], failures: [] } }) }) };
    });
    const result = { status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0 };
    expect(await collectEntries(db, true, result)).toEqual({ entries: reorders, error: null });
  });

  test('no ledger id (nothing applied) is an empty entry list, not a db call', async () => {
    const db = jest.fn(() => { throw new Error('must not query with no ledgerId'); });
    const result = { status: 'completed', ledgerId: null, applied: 0, skipped: 0, failed: 0 };
    expect(await collectEntries(db, true, result)).toEqual({ entries: [], error: null });
  });

  test('a ledger read failure after the writes committed is reported, not thrown', async () => {
    const db = jest.fn(() => ({ where: () => ({ first: async () => { throw new Error('connection lost'); } }) }));
    const result = { status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0 };
    const { entries, error } = await collectEntries(db, true, result);
    expect(entries).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('connection lost');
  });
});

describe('reportAndBackup', () => {
  let logs;
  let errors;
  let logSpy;
  let errorSpy;
  let writeSpy;

  beforeEach(() => {
    logs = [];
    errors = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg));
    errorSpy = jest.spyOn(console, 'error').mockImplementation((msg) => errors.push(msg));
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
  });

  const entries = [{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }];

  test('writes the backup file when entries were read cleanly', () => {
    reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBody] = writeSpy.mock.calls[0];
    expect(writtenPath).toBe(require('path').resolve('/tmp/backup.json'));
    const parsed = JSON.parse(writtenBody);
    expect(parsed.rows).toEqual([{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }]);
  });

  test('no --out path: prints the plan, never touches the filesystem', () => {
    reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: null });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(logs.some((l) => /stop\(s\)/.test(l))).toBe(true);
  });

  test('a ledger read error refuses to write an EMPTY backup — never a silent "nothing changed" file', () => {
    reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries: [], error: new Error('boom'), outPath: '/tmp/backup.json' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(errors.some((e) => /Refusing to write/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e) && /ledger-1/.test(e))).toBe(true);
  });

  test('a filesystem write failure after a successful run still prints the ledger-id recovery instruction', () => {
    writeSpy.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(errors.some((e) => /Failed to write backup file/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e) && /ledger-1/.test(e))).toBe(true);
  });

  test('a filesystem write failure in DRY RUN does not claim writes were committed (nothing to recover)', () => {
    writeSpy.mockImplementation(() => { throw new Error('disk full'); });
    reportAndBackup({ execute: false, result: { ledgerId: null }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(errors.some((e) => /Failed to write backup file/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e))).toBe(false);
  });
});
