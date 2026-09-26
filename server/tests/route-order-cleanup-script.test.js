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
  collectEntries, reportAndBackup, groupRowsByTechDay, readLiveTechDay, mismatchedIdsForDay,
  buildRollbackTargetOrder, rollbackWindowConflict, previewRollback, printRollbackPlan, printRollbackResult,
  buildRunOpts, writeBackupFile,
} = require('../../scripts/route-order-cleanup');
const {
  ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES, classifyWriteError, _internals: reorderInternals,
} = require('../services/route-reorder');
const { guardedCoordSelects } = require('../services/scheduling/day-stops');
const RouteOptimizer = require('../services/route-optimizer');

// The real building blocks writeTechDayOrder itself reads from — passed
// through as `deps` so readLiveTechDay builds the EXACT same select shape
// the writer's own internal re-read does, never a second copy of it. The
// real window-legality guards too (violatesWindowChronology /
// violatesWindowFeasibility) — a rollback proposal is checked with the SAME
// functions chooseWindowSafeOrder itself certifies an order with.
function rollbackDeps(overrides = {}) {
  return {
    ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES, guardedCoordSelects,
    EXCLUDE_STATUSES: reorderInternals.EXCLUDE_STATUSES, LIVE_HOLD_SQL: reorderInternals.LIVE_HOLD_SQL,
    classifyWriteError,
    RouteOptimizer,
    violatesWindowChronology: reorderInternals.violatesWindowChronology,
    violatesWindowFeasibility: reorderInternals.violatesWindowFeasibility,
    ...overrides,
  };
}

// A fake connection for readLiveTechDay: `.select()` returns a thenable that
// is ALSO chainable with `.forUpdate()` — both must resolve to the rows for
// whichever (technician_id, scheduled_date) the query filtered on, keyed
// "techId:dateStr" in `rowsByKey`.
function fakeLiveConn(rowsByKey) {
  const fn = () => {
    const filters = {};
    const chain = {
      where: (col, val) => { filters[col] = val; return chain; },
      whereNotIn: () => chain,
      whereRaw: () => chain,
      leftJoin: () => chain,
      select: () => {
        const key = `${filters['scheduled_services.technician_id']}:${filters['scheduled_services.scheduled_date']}`;
        const rows = rowsByKey[key] || [];
        const thenable = Promise.resolve(rows);
        thenable.forUpdate = () => Promise.resolve(rows);
        return thenable;
      },
    };
    return chain;
  };
  fn.raw = (sql) => sql; // guardedCoordSelects(conn) only needs `.raw` to exist
  return fn;
}

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

describe('mismatchedIdsForDay (the pure "does the backup still match" check)', () => {
  test('every row present at exactly its backed-up "after": no mismatch', () => {
    const dayRows = [{ id: 'a', after: 1 }, { id: 'b', after: 2 }];
    const liveRows = [{ id: 'a', route_order: 1 }, { id: 'b', route_order: 2 }];
    expect(mismatchedIdsForDay(dayRows, liveRows)).toEqual([]);
  });

  test('a route_order that no longer matches "after" is a mismatch', () => {
    const dayRows = [{ id: 'a', after: 1 }];
    const liveRows = [{ id: 'a', route_order: 9 }];
    expect(mismatchedIdsForDay(dayRows, liveRows)).toEqual(['a']);
  });

  test('a row missing from the live read (moved to a DIFFERENT tech-day, or gone) is a mismatch', () => {
    // readLiveTechDay is already scoped to the exact (date, technician_id) —
    // a row reassigned elsewhere since the backup is simply absent here,
    // never a same-route_order coincidence matched against the wrong day
    // (the original codex P1 this check fixed).
    const dayRows = [{ id: 'a', after: 1 }];
    expect(mismatchedIdsForDay(dayRows, [])).toEqual(['a']);
  });

  test('only the genuinely mismatching id is reported, not the whole day\'s ids', () => {
    const dayRows = [{ id: 'a', after: 1 }, { id: 'b', after: 2 }];
    const liveRows = [{ id: 'a', route_order: 1 }, { id: 'b', route_order: 9 }];
    expect(mismatchedIdsForDay(dayRows, liveRows)).toEqual(['b']);
  });
});

describe('buildRollbackTargetOrder', () => {
  test('rows are returned to an earlier "before" position, others keep relative order', () => {
    // Live (canonicalized): X=1, A=2, B=3, Y=4. Backup: A moved 1->2, B moved
    // 2->3 (X was inserted ahead of both). Restoring returns A and B to the
    // front, in their original relative order.
    const live = [
      { id: 'X', route_order: 1 }, { id: 'A', route_order: 2 },
      { id: 'B', route_order: 3 }, { id: 'Y', route_order: 4 },
    ];
    const backup = [{ id: 'A', before: 1 }, { id: 'B', before: 2 }];
    expect(buildRollbackTargetOrder(live, backup).map((r) => r.id)).toEqual(['A', 'B', 'X', 'Y']);
  });

  test('a null "before" leaves the row exactly where it sits live — never moved, never dropped', () => {
    const live = [{ id: 'A', route_order: 1 }, { id: 'B', route_order: 2 }, { id: 'C', route_order: 3 }];
    const backup = [{ id: 'B', before: null }];
    expect(buildRollbackTargetOrder(live, backup).map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  test('a non-numeric "before" is treated the same as null', () => {
    const live = [{ id: 'A', route_order: 1 }, { id: 'B', route_order: 2 }];
    const backup = [{ id: 'B', before: 'oops' }];
    expect(buildRollbackTargetOrder(live, backup).map((r) => r.id)).toEqual(['A', 'B']);
  });

  test('an out-of-range "before" clamps to the nearest valid position instead of throwing', () => {
    const live = [{ id: 'A', route_order: 1 }, { id: 'B', route_order: 2 }];
    const backup = [{ id: 'A', before: 99 }];
    expect(buildRollbackTargetOrder(live, backup).map((r) => r.id)).toEqual(['B', 'A']);
  });

  test('a live row with no route_order (null) sorts last in the current-order baseline', () => {
    const live = [{ id: 'A', route_order: null }, { id: 'B', route_order: 1 }];
    expect(buildRollbackTargetOrder(live, []).map((r) => r.id)).toEqual(['B', 'A']);
  });

  test('multiple restored rows land in ascending "before" order regardless of the backup array\'s own order', () => {
    const live = [{ id: 'X', route_order: 1 }, { id: 'A', route_order: 2 }, { id: 'B', route_order: 3 }];
    // Backup array lists B before A, but B's "before" (1) precedes A's (2).
    const backup = [{ id: 'B', before: 1 }, { id: 'A', before: 2 }];
    expect(buildRollbackTargetOrder(live, backup).map((r) => r.id)).toEqual(['B', 'A', 'X']);
  });
});

describe('rollbackWindowConflict', () => {
  test('a legal chronological order with no window data at all is not a conflict', () => {
    const target = [{ id: 'a' }, { id: 'b' }];
    expect(rollbackWindowConflict(target, target, rollbackDeps())).toBeNull();
  });

  test('restoring a row to an earlier slot whose window is now LATER than the row after it is a WINDOW_ORDER_CONFLICT (windows changed since the backup)', () => {
    // B's window changed from an early slot (when it sat first) to 14:00
    // some time after the backup was taken; route_order was never touched.
    // Restoring B to the front now puts an afternoon promise before A's
    // still-morning one.
    const liveRows = [
      { id: 'A', route_order: 1, window_start: '09:00' },
      { id: 'B', route_order: 2, window_start: '14:00' },
    ];
    const target = [liveRows[1], liveRows[0]]; // [B, A] — B restored to the front
    expect(rollbackWindowConflict(target, liveRows, rollbackDeps())).toBe('WINDOW_ORDER_CONFLICT');
  });

  test('an order whose windows are still chronological is not a conflict', () => {
    const liveRows = [
      { id: 'A', route_order: 1, window_start: '09:00' },
      { id: 'B', route_order: 2, window_start: '14:00' },
    ];
    expect(rollbackWindowConflict(liveRows, liveRows, rollbackDeps())).toBeNull();
  });

  test('feasibility is checked (and reported as WINDOW_FIT_CONFLICT) only when chronology already passed — same short-circuit chooseWindowSafeOrder itself uses', () => {
    const violatesWindowChronology = jest.fn(() => false);
    const violatesWindowFeasibility = jest.fn(() => true);
    const target = [{ id: 'a' }];
    const result = rollbackWindowConflict(target, target, rollbackDeps({ violatesWindowChronology, violatesWindowFeasibility }));
    expect(result).toBe('WINDOW_FIT_CONFLICT');
    expect(violatesWindowChronology).toHaveBeenCalledWith(target, target);
    expect(violatesWindowFeasibility).toHaveBeenCalledWith(RouteOptimizer, target, target, null, 8 * 60, RouteOptimizer.HQ);
  });

  test('a chronology conflict short-circuits — feasibility is never even checked', () => {
    const violatesWindowChronology = jest.fn(() => true);
    const violatesWindowFeasibility = jest.fn();
    const target = [{ id: 'a' }];
    const result = rollbackWindowConflict(target, target, rollbackDeps({ violatesWindowChronology, violatesWindowFeasibility }));
    expect(result).toBe('WINDOW_ORDER_CONFLICT');
    expect(violatesWindowFeasibility).not.toHaveBeenCalled();
  });
});

describe('readLiveTechDay', () => {
  function fakeConn() {
    const calls = { where: [], whereNotIn: [], whereRaw: [], forUpdate: false };
    const fn = (table) => {
      expect(table).toBe('scheduled_services');
      const chain = {
        where: (...a) => { calls.where.push(a); return chain; },
        whereNotIn: (...a) => { calls.whereNotIn.push(a); return chain; },
        whereRaw: (...a) => { calls.whereRaw.push(a); return chain; },
        leftJoin: () => chain,
        select: () => {
          const thenable = Promise.resolve([{ id: 'a' }]);
          thenable.forUpdate = () => { calls.forUpdate = true; return Promise.resolve([{ id: 'a' }]); };
          return thenable;
        },
      };
      return chain;
    };
    fn.raw = (sql) => sql;
    fn._calls = calls;
    return fn;
  }

  test('scopes to the exact (date, technician) live day, excluding terminal statuses and expired holds, unlocked by default', async () => {
    const conn = fakeConn();
    const rows = await readLiveTechDay(conn, { dateStr: '2026-10-05', techId: 't1' }, rollbackDeps());
    expect(rows).toEqual([{ id: 'a' }]);
    expect(conn._calls.where).toEqual([
      ['scheduled_services.scheduled_date', '2026-10-05'],
      ['scheduled_services.technician_id', 't1'],
    ]);
    expect(conn._calls.whereNotIn[0][0]).toBe('scheduled_services.status');
    expect(conn._calls.whereRaw[0][0]).toMatch(/reservation_expires_at/);
    expect(conn._calls.forUpdate).toBe(false);
  });

  test('forUpdate: true locks the rows — used only inside the writer\'s own transaction', async () => {
    const conn = fakeConn();
    await readLiveTechDay(conn, { dateStr: '2026-10-05', techId: 't1', forUpdate: true }, rollbackDeps());
    expect(conn._calls.forUpdate).toBe(true);
  });
});

describe('previewRollback (dry run — reads the live day, no lock, no transaction)', () => {
  test('a fully-matching tech-day would be restored, with a note that eligibility is re-checked at write time', async () => {
    const conn = fakeLiveConn({
      't1:2026-10-05': [{ id: 'a', route_order: 1 }, { id: 'b', route_order: 2 }],
    });
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    expect(await previewRollback(conn, rows, rollbackDeps())).toEqual([{
      technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: true, mismatched_ids: [], conflict: null,
      note: 'eligibility (freeze/lock/today-past) re-checked at write time',
    }]);
  });

  test('one mismatching row marks the WHOLE day as would-skip, listing every mismatching id', async () => {
    const conn = fakeLiveConn({
      't1:2026-10-05': [{ id: 'a', route_order: 1 }, { id: 'b', route_order: 9 }], // 'b' moved again
    });
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    expect(await previewRollback(conn, rows, rollbackDeps())).toEqual([{
      technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: false, mismatched_ids: ['b'], conflict: null, note: null,
    }]);
  });

  test('a row moved to a DIFFERENT tech-day since the backup is a would-skip mismatch', async () => {
    const conn = fakeLiveConn({ 't1:2026-10-05': [] }); // 'a' no longer lives on this tech-day
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    expect(await previewRollback(conn, rows, rollbackDeps())).toEqual([{
      technician_id: 't1', date: '2026-10-05', row_count: 1, would_restore: false, mismatched_ids: ['a'], conflict: null, note: null,
    }]);
  });

  test('windows changed since the backup (route_order untouched) → would-skip with the window guard\'s reason, not a false would-restore', async () => {
    // B's window moved from an early slot (when it sat first) to 14:00 after
    // the backup was taken; both rows still match the backup's "after"
    // route_order exactly (no MISMATCH), so only the window-legality
    // recheck catches this.
    const conn = fakeLiveConn({
      't1:2026-10-05': [
        { id: 'A', route_order: 1, window_start: '09:00' },
        { id: 'B', route_order: 2, window_start: '14:00' },
      ],
    });
    const rows = [
      { id: 'A', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'B', date: '2026-10-05', technician_id: 't1', before: 1, after: 2 },
    ];
    expect(await previewRollback(conn, rows, rollbackDeps())).toEqual([{
      technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: false,
      mismatched_ids: [], conflict: 'WINDOW_ORDER_CONFLICT', note: null,
    }]);
  });
});

describe('applyRollback — hands each eligible tech-day to the SAME fenced writer', () => {
  const NOW = new Date('2026-09-27T12:00:00Z');

  test('a mismatching row skips the WHOLE tech-day WITHOUT ever calling the writer', async () => {
    const conn = fakeLiveConn({
      't1:2026-10-05': [{ id: 'a', route_order: 1 }, { id: 'b', route_order: 9 }],
    });
    const writeTechDayOrder = jest.fn();
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'b', date: '2026-10-05', technician_id: 't1', before: null, after: 2 },
    ];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(writeTechDayOrder).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.summary.skipped).toEqual([{
      date: '2026-10-05', technician_id: 't1', reason: 'MISMATCH',
      detail: 'no longer matches the backup (ids only): b',
      mismatched_ids: ['b'],
    }]);
  });

  test('windows changed since the backup (route_order untouched) skips the day with the window guard\'s reason, WITHOUT ever calling the writer', async () => {
    const conn = fakeLiveConn({
      't1:2026-10-05': [
        { id: 'A', route_order: 1, window_start: '09:00' },
        { id: 'B', route_order: 2, window_start: '14:00' },
      ],
    });
    const writeTechDayOrder = jest.fn();
    const rows = [
      { id: 'A', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'B', date: '2026-10-05', technician_id: 't1', before: 1, after: 2 },
    ];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(writeTechDayOrder).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    expect(result.summary.skipped).toEqual([{
      date: '2026-10-05', technician_id: 't1', reason: 'WINDOW_ORDER_CONFLICT',
      detail: 'the restored order would violate a promised window — windows likely changed since the backup',
    }]);
    expect(result.summary.failed).toEqual([]);
  });

  test('an eligible tech-day hands the writer the live snapshot and the restored target order, and counts it restored', async () => {
    // Live (canonicalized): X=1, A=2, B=3. Backup: A moved 1->2, B moved 2->3.
    const liveRows = [
      { id: 'X', route_order: 1 }, { id: 'A', route_order: 2 }, { id: 'B', route_order: 3 },
    ];
    const conn = fakeLiveConn({ 't1:2026-10-05': liveRows });
    const writeTechDayOrder = jest.fn(async () => {});
    const rows = [
      { id: 'A', date: '2026-10-05', technician_id: 't1', before: 1, after: 2 },
      { id: 'B', date: '2026-10-05', technician_id: 't1', before: 2, after: 3 },
    ];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(writeTechDayOrder).toHaveBeenCalledTimes(1);
    const [passedConn, args] = writeTechDayOrder.mock.calls[0];
    expect(passedConn).toBe(conn);
    expect(args.dateStr).toBe('2026-10-05');
    expect(args.techId).toBe('t1');
    // techStops is the writer's OWN comparison snapshot — the live read just taken.
    expect(args.techStops).toBe(liveRows);
    expect(args.finalOrdered.map((r) => r.id)).toEqual(['A', 'B', 'X']);
    expect(args.repair).toBeNull();
    expect(args.opts).toEqual({});
    expect(args.now).toBe(NOW);
    expect(args.repairGates).toEqual([]);
    expect(result.restored).toBe(2);
    expect(result.summary.skipped).toEqual([]);
    expect(result.summary.failed).toEqual([]);
  });

  test('a STALE_TECH_DAY the writer refuses is reported as skipped via the REAL classifyWriteError, not a run-degrading failure', async () => {
    const conn = fakeLiveConn({ 't1:2026-10-05': [{ id: 'a', route_order: 1 }] });
    const writeTechDayOrder = jest.fn(async () => {
      throw Object.assign(new Error('stop a route_order changed during the run'), { code: 'STALE_TECH_DAY' });
    });
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(result.restored).toBe(0);
    expect(result.summary.skipped).toEqual([{
      date: '2026-10-05', technician_id: 't1', reason: 'STALE_TECH_DAY',
      detail: 'stop a route_order changed during the run',
    }]);
    expect(result.summary.failed).toEqual([]);
  });

  test('a LOCKED_STOP the writer refuses (rollback has no lock pre-check of its own) is reported as skipped', async () => {
    const conn = fakeLiveConn({ 't1:2026-10-05': [{ id: 'a', route_order: 1 }] });
    const writeTechDayOrder = jest.fn(async () => {
      throw Object.assign(new Error('a stop on this tech-day is staff-locked'), { code: 'LOCKED_STOP' });
    });
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(result.restored).toBe(0);
    expect(result.summary.skipped).toEqual([{
      date: '2026-10-05', technician_id: 't1', reason: 'LOCKED_STOP', detail: 'a stop on this tech-day is staff-locked',
    }]);
  });

  test('an unreadable reminder-freeze status at commit fails closed into the FAILED list, not skipped', async () => {
    const conn = fakeLiveConn({ 't1:2026-10-05': [{ id: 'a', route_order: 1 }] });
    const writeTechDayOrder = jest.fn(async () => {
      throw Object.assign(new Error('reminder status unreadable at commit'), { code: 'REMINDER_GUARD_OUTAGE' });
    });
    const rows = [{ id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 }];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(result.restored).toBe(0);
    expect(result.summary.failed).toEqual([{
      date: '2026-10-05', technician_id: 't1', reason: 'REMINDER_STATUS_UNKNOWN', error: 'reminder status unreadable at commit',
    }]);
    expect(result.summary.skipped).toEqual([]);
  });

  test('two independent tech-days: one restores, one is skipped for mismatch — neither affects the other', async () => {
    const conn = fakeLiveConn({
      't1:2026-10-05': [{ id: 'a', route_order: 1 }],
      't2:2026-10-06': [{ id: 'c', route_order: 9 }], // moved again
    });
    const writeTechDayOrder = jest.fn(async () => {});
    const rows = [
      { id: 'a', date: '2026-10-05', technician_id: 't1', before: 2, after: 1 },
      { id: 'c', date: '2026-10-06', technician_id: 't2', before: 4, after: 1 },
    ];
    const result = await applyRollback(conn, rows, NOW, rollbackDeps({ writeTechDayOrder }));
    expect(writeTechDayOrder).toHaveBeenCalledTimes(1);
    expect(result.restored).toBe(1);
    expect(result.summary.skipped).toEqual([{
      date: '2026-10-06', technician_id: 't2', reason: 'MISMATCH',
      detail: 'no longer matches the backup (ids only): c', mismatched_ids: ['c'],
    }]);
  });

  test('an empty backup takes no live read and calls the writer zero times', async () => {
    const writeTechDayOrder = jest.fn();
    const conn = jest.fn(() => { throw new Error('must not query with an empty backup'); });
    const result = await applyRollback(conn, [], NOW, rollbackDeps({ writeTechDayOrder }));
    expect(result).toEqual({ restored: 0, summary: { skipped: [], failed: [] } });
    expect(writeTechDayOrder).not.toHaveBeenCalled();
  });
});

describe('printRollbackPlan / printRollbackResult', () => {
  let logs;
  let logSpy;
  beforeEach(() => { logs = []; logSpy = jest.spyOn(console, 'log').mockImplementation((msg) => logs.push(msg)); });
  afterEach(() => logSpy.mockRestore());

  test('printRollbackPlan reports a would-restore day with its note, and a would-skip day with its mismatching ids', () => {
    printRollbackPlan([
      { technician_id: 't1', date: '2026-10-05', row_count: 2, would_restore: true, mismatched_ids: [], note: 'eligibility (freeze/lock/today-past) re-checked at write time' },
      { technician_id: 't2', date: '2026-10-06', row_count: 1, would_restore: false, mismatched_ids: ['x'], note: null },
    ]);
    expect(logs.some((l) => /would restore 2 row.*re-checked at write time/.test(l))).toBe(true);
    expect(logs.some((l) => /WOULD SKIP/.test(l) && /x/.test(l))).toBe(true);
  });

  test('printRollbackResult reports the restored count and every skipped/failed tech-day with its reason', () => {
    printRollbackResult({
      restored: 3,
      summary: {
        skipped: [{ date: '2026-10-05', technician_id: 't1', reason: 'MISMATCH', detail: 'no longer matches the backup (ids only): b' }],
        failed: [{ date: '2026-10-06', technician_id: 't2', reason: 'REMINDER_STATUS_UNKNOWN', error: 'boom' }],
      },
    }, 5);
    expect(logs.some((l) => /Restored 3\/5/.test(l))).toBe(true);
    expect(logs.some((l) => /2 tech-day\(s\) skipped/.test(l))).toBe(true);
    expect(logs.some((l) => /2026-10-05 tech t1: MISMATCH — no longer matches the backup.*b/.test(l))).toBe(true);
    expect(logs.some((l) => /2026-10-06 tech t2: REMINDER_STATUS_UNKNOWN — boom/.test(l))).toBe(true);
  });

  test('a fully successful rollback prints no skipped section', () => {
    printRollbackResult({ restored: 2, summary: { skipped: [], failed: [] } }, 2);
    expect(logs.some((l) => /skipped/.test(l))).toBe(false);
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
