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
  collectEntries, reportAndBackup, groupRowsByTechDay, checkTechDay, previewRollback,
  printRollbackPlan, printRollbackResult, buildRunOpts, writeBackupFile,
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

describe('groupRowsByTechDay', () => {
  test('groups rows into one entry per (technician_id, date)', () => {
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1' },
      { id: 'b', date: '2026-10-05', technician_id: 't1' },
      { id: 'c', date: '2026-10-05', technician_id: 't2' },
      { id: 'd', date: '2026-10-06', technician_id: 't1' },
    ];
    const groups = groupRowsByTechDay(rows);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.technician_id === 't1' && g.date === '2026-10-05').rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(groups.find((g) => g.technician_id === 't2').rows.map((r) => r.id)).toEqual(['c']);
    expect(groups.find((g) => g.date === '2026-10-06').rows.map((r) => r.id)).toEqual(['d']);
  });
});

// A live scheduled_services row, promise-shaped for checkTechDay's
// eligibility queries: [id, route_order, scheduled_date, technician_id]
// plus optional window_start/auto_dispatch_locked/auto_dispatch_excluded.
function fakeConn(liveRows) {
  return () => ({
    whereIn: (col, ids) => ({
      select: () => {
        const filtered = liveRows.filter((r) => ids.includes(r.id));
        const thenable = Promise.resolve(filtered);
        // A real knex query is thenable AND chainable with .forUpdate() —
        // both must resolve to the SAME rows (locking changes nothing about
        // what's read, only who else can touch them concurrently).
        thenable.forUpdate = () => Promise.resolve(filtered);
        return thenable;
      },
    }),
  });
}

// Eligible-by-default deps (today is 2020-01-01 — always before any test's
// day.date; no freeze, no lock) with per-test overrides.
function makeRollbackDeps(overrides = {}) {
  return {
    etDateString: overrides.etDateString || (() => '2020-01-01'),
    withinFreezeClock: overrides.withinFreezeClock || (() => false),
    loadReminderFreeze: overrides.loadReminderFreeze || (async () => ({ failed: false, frozen: new Set() })),
  };
}

const ROLLBACK_NOW = new Date('2026-09-27T12:00:00Z');

describe('checkTechDay', () => {
  const oneRowDay = (row) => ({ technician_id: row.technician_id, date: row.date, rows: [row] });

  test('today or a past date is never eligible (TODAY_OR_PAST) — no query needed', async () => {
    const conn = () => { throw new Error('must not query when the date is already today/past'); };
    const deps = makeRollbackDeps({ etDateString: () => '2026-10-05' }); // >= day.date
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, deps)).toEqual({ ineligibleReason: 'TODAY_OR_PAST', mismatchedIds: [] });
  });

  test('a locked or excluded stop freezes the whole day (LOCKED_STOP)', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1', auto_dispatch_locked: true }]);
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps())).toEqual({ ineligibleReason: 'LOCKED_STOP', mismatchedIds: [] });
  });

  test('an unreadable reminder-freeze status fails closed (REMINDER_STATUS_UNKNOWN)', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }]);
    const deps = makeRollbackDeps({ loadReminderFreeze: async () => ({ failed: true, frozen: new Set() }) });
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, deps)).toEqual({ ineligibleReason: 'REMINDER_STATUS_UNKNOWN', mismatchedIds: [] });
  });

  test('a 72h reminder already sent freezes the day (REMINDER_SENT_FROZEN)', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }]);
    const deps = makeRollbackDeps({ loadReminderFreeze: async () => ({ failed: false, frozen: new Set(['a']) }) });
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, deps)).toEqual({ ineligibleReason: 'REMINDER_SENT_FROZEN', mismatchedIds: [] });
  });

  test('a promise inside the 72h clock freezes the day (WITHIN_72H)', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1', window_start: '09:00' }]);
    const deps = makeRollbackDeps({ withinFreezeClock: () => true });
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, deps)).toEqual({ ineligibleReason: 'WITHIN_72H', mismatchedIds: [] });
  });

  test('a row missing entirely is a mismatch (once eligible)', async () => {
    const conn = fakeConn([]);
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps())).toEqual({ ineligibleReason: null, mismatchedIds: ['a'] });
  });

  test('a route_order that no longer matches "after" is a mismatch', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 9, scheduled_date: '2026-10-05', technician_id: 't1' }]);
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps())).toEqual({ ineligibleReason: null, mismatchedIds: ['a'] });
  });

  test('a row moved to a DIFFERENT tech-day since the backup is a mismatch — even with the same route_order', async () => {
    // The original codex P1: id + route_order alone would match.
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-06', technician_id: 't2' }]);
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps())).toEqual({ ineligibleReason: null, mismatchedIds: ['a'] });
  });

  test('eligible AND still matching: no reason, no mismatch', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }]);
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    expect(await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps())).toEqual({ ineligibleReason: null, mismatchedIds: [] });
  });

  test('forUpdate: true locks the rows for the real rollback', async () => {
    let forUpdateCalled = false;
    const liveRows = [{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }];
    const conn = () => ({
      whereIn: (col, ids) => ({
        select: () => {
          const filtered = liveRows.filter((r) => ids.includes(r.id));
          const thenable = Promise.resolve(filtered);
          thenable.forUpdate = () => { forUpdateCalled = true; return Promise.resolve(filtered); };
          return thenable;
        },
      }),
    });
    const row = { id: 'a', date: '2026-10-05', technician_id: 't1', after: 1 };
    await checkTechDay(conn, oneRowDay(row), ROLLBACK_NOW, makeRollbackDeps(), { forUpdate: true });
    expect(forUpdateCalled).toBe(true);
  });
});

describe('previewRollback (dry run — read-only, no lock, no transaction)', () => {
  test('a fully-matching, eligible tech-day would be restored', async () => {
    const conn = fakeConn([
      { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' },
      { id: 'b', route_order: 2, scheduled_date: '2026-10-05', technician_id: 't1' },
    ]);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    expect(await previewRollback(conn, rows, ROLLBACK_NOW, makeRollbackDeps())).toEqual([
      { technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: true, ineligible_reason: null, mismatched_ids: [] },
    ]);
  });

  test('one mismatching row marks the WHOLE day as would-skip, listing every id in that day', async () => {
    const conn = fakeConn([
      { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' },
      { id: 'b', route_order: 9, scheduled_date: '2026-10-05', technician_id: 't1' }, // moved again
    ]);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    expect(await previewRollback(conn, rows, ROLLBACK_NOW, makeRollbackDeps())).toEqual([
      { technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: false, ineligible_reason: null, mismatched_ids: ['b'] },
    ]);
  });

  test('an ineligible day (e.g. WITHIN_72H) would-skip with its reason, without ever computing mismatches', async () => {
    const conn = fakeConn([{ id: 'a', route_order: 9, scheduled_date: '2026-10-05', technician_id: 't1', window_start: '09:00' }]); // would ALSO mismatch
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const deps = makeRollbackDeps({ withinFreezeClock: () => true });
    expect(await previewRollback(conn, rows, ROLLBACK_NOW, deps)).toEqual([
      { technician_id: 't1', date: '2026-10-05', row_count: 1, would_restore: false, ineligible_reason: 'WITHIN_72H', mismatched_ids: [] },
    ]);
  });
});

describe('applyRollback — all-or-nothing per tech-day', () => {
  // Simulates the FOR UPDATE re-read (`liveRows`, the current state) and the
  // CAS UPDATE outcome (`updateResults`, keyed on the full CAS tuple) as two
  // independent inputs — a savepoint's writes only land in the shared
  // `calls` log if its callback resolves; a thrown callback discards them,
  // exactly like a real Postgres SAVEPOINT rollback.
  function fakeTrx({ liveRows = [], updateResults = {} } = {}) {
    const calls = [];
    function queryBuilder(table, sink) {
      return {
        whereIn: (col, ids) => ({
          select: () => {
            const filtered = liveRows.filter((r) => ids.includes(r.id));
            const thenable = Promise.resolve(filtered);
            thenable.forUpdate = () => Promise.resolve(filtered);
            return thenable;
          },
        }),
        where: (filter) => ({
          update: async (patch) => {
            const key = `${filter.id}:${filter.route_order}:${filter.scheduled_date}:${filter.technician_id}`;
            const affected = updateResults[key] ?? 0;
            sink.push({ table, filter, patch, affected });
            return affected;
          },
        }),
      };
    }
    const trx = (table) => queryBuilder(table, calls);
    trx.transaction = async (cb) => {
      const pending = [];
      const result = await cb((table) => queryBuilder(table, pending));
      calls.push(...pending); // "commit" the savepoint — only reached if cb didn't throw
      return result;
    };
    return { trx, calls };
  }

  test('two fully-matching tech-days each restore in their own savepoint', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [
        { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' },
        { id: 'b', route_order: 1, scheduled_date: '2026-10-06', technician_id: 't2' },
      ],
      updateResults: { 'a:1:2026-10-05:t1': 1, 'b:1:2026-10-06:t2': 1 },
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-06', technician_id: 't2', before: 3, after: 1 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({ restored: 2, mismatched: [], skippedDays: [] });
    expect(lockTechDays).toHaveBeenCalledWith(trx, [
      { techId: 't1', date: '2026-10-05' },
      { techId: 't2', date: '2026-10-06' },
    ]);
    expect(calls.map((c) => c.filter.id)).toEqual(['a', 'b']);
  });

  test('one mismatching row skips the WHOLE tech-day — its sibling row is never written, and a separate day is unaffected', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [
        { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }, // matches
        { id: 'b', route_order: 9, scheduled_date: '2026-10-05', technician_id: 't1' }, // moved again — mismatch
        { id: 'c', route_order: 1, scheduled_date: '2026-10-06', technician_id: 't2' }, // separate day, matches
      ],
      updateResults: { 'a:1:2026-10-05:t1': 1, 'c:1:2026-10-06:t2': 1 },
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
      { id: 'c', date: '2026-10-06', technician_id: 't2', before: 4, after: 1 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({
      restored: 1,
      // The WHOLE day 10-05 is skipped (its matching row 'a' is never
      // written either), but only the GENUINELY mismatching id is reported
      // — the pre-check never even attempted 'a's write.
      mismatched: ['b'],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'MISMATCH', mismatched_ids: ['b'] }],
    });
    // 'a' (day 10-05) must NOT appear among the committed writes — only 'c' (day 10-06) does.
    expect(calls.map((c) => c.filter.id)).toEqual(['c']);
  });

  test('a row moved to a DIFFERENT tech-day since the backup skips its whole (single-row) day', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [{ id: 'a', route_order: 1, scheduled_date: '2026-10-06', technician_id: 't2' }], // reassigned since backup
      updateResults: {},
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({
      restored: 0,
      mismatched: ['a'],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'MISMATCH', mismatched_ids: ['a'] }],
    });
    expect(calls).toEqual([]);
  });

  test('a CAS somehow affecting 0 rows despite the pre-check rolls back the WHOLE day, not just that row', async () => {
    // Pre-check (liveRows) says both rows still match — but the UPDATE for
    // 'b' is wired to affect 0 rows anyway (a same-transaction anomaly).
    // The savepoint must roll back 'a's write too.
    const { trx, calls } = fakeTrx({
      liveRows: [
        { id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' },
        { id: 'b', route_order: 2, scheduled_date: '2026-10-05', technician_id: 't1' },
      ],
      updateResults: { 'a:1:2026-10-05:t1': 1 }, // 'b's CAS key is absent -> affected 0
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 3, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: 4, after: 2 },
    ];
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({
      restored: 0,
      mismatched: ['a', 'b'],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'MISMATCH', mismatched_ids: ['a', 'b'] }],
    });
    // 'a's write was attempted but never committed — the savepoint rolled it back.
    expect(calls).toEqual([]);
  });

  test('a locked stop skips the whole day without any write attempted (LOCKED_STOP)', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1', auto_dispatch_locked: true }],
      updateResults: { 'a:1:2026-10-05:t1': 1 }, // would match — the lock alone must refuse it
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({
      restored: 0, mismatched: [],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'LOCKED_STOP', mismatched_ids: [] }],
    });
    expect(calls).toEqual([]);
  });

  test('a promise inside the 72h clock skips the whole day without any write attempted (WITHIN_72H)', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1', window_start: '09:00' }],
      updateResults: { 'a:1:2026-10-05:t1': 1 },
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const deps = makeRollbackDeps({ withinFreezeClock: () => true });
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, deps);
    expect(result).toEqual({
      restored: 0, mismatched: [],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'WITHIN_72H', mismatched_ids: [] }],
    });
    expect(calls).toEqual([]);
  });

  test('a reminder already sent skips the whole day without any write attempted (REMINDER_SENT_FROZEN)', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }],
      updateResults: { 'a:1:2026-10-05:t1': 1 },
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const deps = makeRollbackDeps({ loadReminderFreeze: async () => ({ failed: false, frozen: new Set(['a']) }) });
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, deps);
    expect(result).toEqual({
      restored: 0, mismatched: [],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'REMINDER_SENT_FROZEN', mismatched_ids: [] }],
    });
    expect(calls).toEqual([]);
  });

  test('today or a past date skips the whole day without any write attempted (TODAY_OR_PAST)', async () => {
    const { trx, calls } = fakeTrx({
      liveRows: [{ id: 'a', route_order: 1, scheduled_date: '2026-10-05', technician_id: 't1' }],
      updateResults: { 'a:1:2026-10-05:t1': 1 },
    });
    const lockTechDays = jest.fn(async () => []);
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const deps = makeRollbackDeps({ etDateString: () => '2026-10-05' });
    const result = await applyRollback(trx, lockTechDays, rows, ROLLBACK_NOW, deps);
    expect(result).toEqual({
      restored: 0, mismatched: [],
      skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'TODAY_OR_PAST', mismatched_ids: [] }],
    });
    expect(calls).toEqual([]);
  });

  test('an empty backup takes no lock and touches nothing', async () => {
    const lockTechDays = jest.fn();
    const result = await applyRollback({}, lockTechDays, [], ROLLBACK_NOW, makeRollbackDeps());
    expect(result).toEqual({ restored: 0, mismatched: [], skippedDays: [] });
    expect(lockTechDays).not.toHaveBeenCalled();
  });
});

describe('printRollbackPlan / printRollbackResult', () => {
  let logs;
  let logSpy;
  beforeEach(() => { logs = []; logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg)); });
  afterEach(() => logSpy.mockRestore());

  test('printRollbackPlan reports a would-restore day and a would-skip-for-mismatch day with its mismatching ids', () => {
    printRollbackPlan([
      { technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: true, ineligible_reason: null, mismatched_ids: [] },
      { technician_id: 't2', date: '2026-10-06', row_count: 1, would_restore: false, ineligible_reason: null, mismatched_ids: ['x'] },
    ]);
    expect(logs.some((l) => /would restore 2 row/.test(l))).toBe(true);
    expect(logs.some((l) => /WOULD SKIP/.test(l) && /x/.test(l))).toBe(true);
  });

  test('printRollbackPlan reports a would-skip-for-ineligibility day with its reason', () => {
    printRollbackPlan([
      { technician_id: 't3', date: '2026-10-07', row_count: 1, would_restore: false, ineligible_reason: 'WITHIN_72H', mismatched_ids: [] },
    ]);
    expect(logs.some((l) => /WOULD SKIP/.test(l) && /ineligible \(WITHIN_72H\)/.test(l))).toBe(true);
  });

  test('printRollbackResult reports the restored count and a mismatched skipped day', () => {
    printRollbackResult({ restored: 3, mismatched: ['b'], skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'MISMATCH', mismatched_ids: ['b'] }] }, 5);
    expect(logs.some((l) => /Restored 3\/5/.test(l))).toBe(true);
    expect(logs.some((l) => /1 tech-day\(s\) skipped whole/.test(l))).toBe(true);
    expect(logs.some((l) => /2026-10-05 tech t1: no longer matches the backup.*b/.test(l))).toBe(true);
  });

  test('printRollbackResult reports an ineligible skipped day with its reason', () => {
    printRollbackResult({ restored: 0, mismatched: [], skippedDays: [{ technician_id: 't1', date: '2026-10-05', reason: 'LOCKED_STOP', mismatched_ids: [] }] }, 1);
    expect(logs.some((l) => /2026-10-05 tech t1: ineligible \(LOCKED_STOP\)/.test(l))).toBe(true);
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

  test('with no primary evidence at all, a ledger read failure IS an error (nothing to fall back on)', async () => {
    const db = jest.fn(() => ({ where: () => ({ first: async () => { throw new Error('connection lost'); } }) }));
    const result = { status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0 }; // no appliedChanges
    const { entries, error } = await collectEntries(db, true, result);
    expect(entries).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/neither its own result nor the ledger/);
  });

  // ── codex pre-push P1: runRouteReorder can commit changes and then return
  // ledgerId:null (or the read-back finds no row) — the run's OWN
  // appliedChanges is the PRIMARY evidence and must save the backup either
  // way; the ledger is a cross-check only. ──
  test('a null ledgerId (ledger insert failed) after real writes still builds the backup from appliedChanges', async () => {
    const db = jest.fn(() => { throw new Error('must not be queried with no ledgerId'); });
    const result = {
      status: 'completed', ledgerId: null, applied: 1, skipped: 0, failed: 0,
      appliedChanges: [{ date: '2026-10-05', technicianId: 't1', changes: [{ id: 'a', before: 2, after: 1 }] }],
    };
    expect(await collectEntries(db, true, result)).toEqual({
      entries: [{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }],
      error: null,
    });
  });

  test('a ledger read failure with real appliedChanges evidence still builds the backup — no error', async () => {
    const db = jest.fn(() => ({ where: () => ({ first: async () => { throw new Error('connection lost'); } }) }));
    const result = {
      status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0,
      appliedChanges: [{ date: '2026-10-05', technicianId: 't1', changes: [{ id: 'a', before: 2, after: 1 }] }],
    };
    const { entries, error } = await collectEntries(db, true, result);
    expect(error).toBeNull();
    expect(entries).toEqual([{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }]);
  });

  test('appliedChanges (primary) wins over the ledger even when the ledger read succeeds', async () => {
    // Same underlying evidence in practice (both are written from the same
    // in-memory summary), but this proves precedence, not just fallback.
    const ledgerReorders = [{ date: '2026-10-05', technician_id: 't1', canonicalized: { reasons: ['gap'], source: 'google' }, route_order_changes: [{ id: 'a', before: 2, after: 1 }] }];
    const db = jest.fn(() => ({ where: () => ({ first: async () => ({ result: { reorders: ledgerReorders } }) }) }));
    const result = {
      status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0,
      appliedChanges: [{ date: '2026-10-05', technicianId: 't1', changes: [{ id: 'a', before: 2, after: 1 }] }],
    };
    const { entries, error } = await collectEntries(db, true, result);
    expect(error).toBeNull();
    expect(entries).toEqual([{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }]);
  });

  test('a mismatch between appliedChanges and the ledger prints a warning but still uses appliedChanges', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ledgerReorders = [{ date: '2026-10-05', technician_id: 't1', route_order_changes: [] }]; // ledger under-counts
    const db = jest.fn(() => ({ where: () => ({ first: async () => ({ result: { reorders: ledgerReorders } }) }) }));
    const result = {
      status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0,
      appliedChanges: [{ date: '2026-10-05', technicianId: 't1', changes: [{ id: 'a', before: 2, after: 1 }] }],
    };
    const { entries, error } = await collectEntries(db, true, result);
    expect(error).toBeNull();
    expect(entries[0].route_order_changes).toEqual([{ id: 'a', before: 2, after: 1 }]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Warning:.*1 row change.*ledger reports 0/));
    errorSpy.mockRestore();
  });

  test('both sources genuinely empty with applied > 0 is an error, not a silent empty backup', async () => {
    const db = jest.fn(() => ({ where: () => ({ first: async () => ({ result: { reorders: [] } }) }) }));
    const result = { status: 'completed', ledgerId: 'ledger-1', applied: 1, skipped: 0, failed: 0 }; // no appliedChanges either
    const { entries, error } = await collectEntries(db, true, result);
    expect(entries).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/neither its own result nor the ledger/);
  });

  test('applied === 0 with no evidence anywhere is NOT an error — there was nothing to back up', async () => {
    const db = jest.fn(() => ({ where: () => ({ first: async () => null }) }));
    const result = { status: 'completed', ledgerId: 'ledger-1', applied: 0, skipped: 3, failed: 0 };
    expect(await collectEntries(db, true, result)).toEqual({ entries: [], error: null });
  });
});

describe('writeBackupFile', () => {
  let writeSpy;
  let renameSpy;
  beforeEach(() => {
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {});
  });
  afterEach(() => {
    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  test('writes to a .tmp sibling, then renames it into place — never writes the final path directly', () => {
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    writeBackupFile('/tmp/backup.json', rows);
    const resolved = require('path').resolve('/tmp/backup.json');
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBody] = writeSpy.mock.calls[0];
    expect(writtenPath).toBe(`${resolved}.tmp`);
    expect(JSON.parse(writtenBody).rows).toEqual(rows);
    expect(renameSpy).toHaveBeenCalledWith(`${resolved}.tmp`, resolved);
  });

  test('a write failure never reaches the rename — an existing backup at the final path is untouched', () => {
    writeSpy.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => writeBackupFile('/tmp/backup.json', [])).toThrow('disk full');
    expect(renameSpy).not.toHaveBeenCalled();
  });
});

describe('reportAndBackup', () => {
  let logs;
  let errors;
  let logSpy;
  let errorSpy;
  let writeSpy;
  let renameSpy;

  beforeEach(() => {
    logs = [];
    errors = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg));
    errorSpy = jest.spyOn(console, 'error').mockImplementation((msg) => errors.push(msg));
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  const entries = [{ date: '2026-10-05', technicianId: 't1', route_order_changes: [{ id: 'a', before: 2, after: 1 }] }];

  test('writes the backup file (via the tmp+rename path) when entries were read cleanly', () => {
    const outcome = reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(outcome).toEqual({ backupFailed: false });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const resolved = require('path').resolve('/tmp/backup.json');
    const [writtenPath, writtenBody] = writeSpy.mock.calls[0];
    expect(writtenPath).toBe(`${resolved}.tmp`);
    expect(renameSpy).toHaveBeenCalledWith(`${resolved}.tmp`, resolved);
    const parsed = JSON.parse(writtenBody);
    expect(parsed.rows).toEqual([{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }]);
  });

  test('no --out path: prints the plan, never touches the filesystem', () => {
    const outcome = reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: null });
    expect(outcome).toEqual({ backupFailed: false });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(logs.some((l) => /stop\(s\)/.test(l))).toBe(true);
  });

  test('a ledger read error refuses to write an EMPTY backup — never a silent "nothing changed" file', () => {
    const outcome = reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries: [], error: new Error('boom'), outPath: '/tmp/backup.json' });
    expect(outcome).toEqual({ backupFailed: false });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(errors.some((e) => /Refusing to write/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e) && /ledger-1/.test(e))).toBe(true);
  });

  test('a filesystem write failure after a successful run reports backupFailed AND prints the ledger-id recovery instruction', () => {
    writeSpy.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    const outcome = reportAndBackup({ execute: true, result: { ledgerId: 'ledger-1' }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(outcome).toEqual({ backupFailed: true });
    expect(errors.some((e) => /Failed to write backup file/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e) && /ledger-1/.test(e))).toBe(true);
    // The final path was never touched — only the never-renamed .tmp file was attempted.
    expect(renameSpy).not.toHaveBeenCalled();
  });

  test('a filesystem write failure in DRY RUN reports backupFailed but does not claim writes were committed (nothing to recover)', () => {
    writeSpy.mockImplementation(() => { throw new Error('disk full'); });
    const outcome = reportAndBackup({ execute: false, result: { ledgerId: null }, entries, error: null, outPath: '/tmp/backup.json' });
    expect(outcome).toEqual({ backupFailed: true });
    expect(errors.some((e) => /Failed to write backup file/.test(e))).toBe(true);
    expect(errors.some((e) => /ALREADY COMMITTED/.test(e))).toBe(false);
  });
});

describe('buildRunOpts', () => {
  const now = new Date('2026-09-27T04:20:00Z');

  test('--execute omits `now` entirely — runRouteReorder must read the real wall clock at commit time', () => {
    // The exact codex P1: passing a fixed `now` here would freeze BOTH the
    // load-time freeze check and writeTechDayOrder's commit-time re-check
    // to this one instant for the whole run, even if it takes minutes.
    const opts = buildRunOpts({ execute: true, dates: ['2026-10-05'], now, runType: 'route_order_cleanup' });
    expect(opts).toEqual({ canonicalizeStale: true, dates: ['2026-10-05'], dryRun: false, runType: 'route_order_cleanup' });
    expect(opts).not.toHaveProperty('now');
  });

  test('dry run keeps `now` — nothing commits, so one consistent preview clock across the whole range is safe', () => {
    const opts = buildRunOpts({ execute: false, dates: ['2026-10-05'], now, runType: 'route_order_cleanup' });
    expect(opts).toEqual({ canonicalizeStale: true, dates: ['2026-10-05'], dryRun: true, runType: 'route_order_cleanup', now });
  });
});
