#!/usr/bin/env node
/**
 * Stale route-order cleanup — the manual companion to the nightly
 * canonicalization mode in server/services/route-reorder.js (owner-approved
 * 2026-09-26: "kill the stale June numbers"; "a driveable order beats a
 * stale one"). Runs the SAME code path the nightly pass uses when
 * GATE_ROUTE_REORDER_STALE_ORDER is on — canonicalizeStale:true — over a
 * wider, operator-chosen date range (default D+3..D+30 ET; the nightly
 * band, D+1..D+6, is unaffected by this script), so an operator can clear
 * a backlog of stale numbering without waiting for the band to reach it or
 * flipping the gate for the fleet.
 *
 * Dry-run by default (no writes, no ledger row — see runRouteReorder's
 * opts.dryRun): prints the plan exactly as the real run would compute it.
 * --execute runs for real, through the identical fenced writer every other
 * route_order writer uses (every freeze, LOCKED_STOP, and window guard
 * still applies — this script adds no new writer, only a wider date range
 * and an operator trigger).
 *
 * --out <path> writes a backup JSON of every row this run changed (or
 * would change, in dry run): {generated_at, rows:[{id, date,
 * technician_id, before, after}]}. --rollback <path> restores exactly
 * those rows from a PRIOR --execute run's backup file — DRY RUN BY
 * DEFAULT, same convention as the rest of the script: it prints the
 * would-restore plan and any per-day mismatches and opens no write
 * transaction; --rollback <path> --execute performs it.
 *
 * The rollback write goes through the EXACT SAME fenced writer every other
 * route_order write in the app uses (writeTechDayOrder, the function
 * runRouteReorder's own per-tech loop calls) rather than a second,
 * hand-rolled copy of its guards. For each backed-up tech-day: the full
 * live day is re-read; if every backed-up row still sits at its "after" on
 * that tech-day (id present AND at exactly that route_order — a row moved
 * to a DIFFERENT tech-day since the backup is simply absent from that
 * read, never a same-route_order coincidence silently matched), the live
 * order with those rows returned to their backup "before" positions
 * (non-backed-up rows keep their relative order) is handed to
 * writeTechDayOrder as an ordinary write, with that same live read as its
 * expected snapshot. The writer re-reads the day itself, under its OWN
 * advisory lock, inside its OWN SERIALIZABLE transaction, FOR UPDATE, and
 * makes every guard check it makes for any other write — membership,
 * window/order/coordinate drift, LOCKED_STOP, and, with a clock read fresh
 * at commit time, today/past and the 72h reminder freeze — so a rollback
 * can never reinstate a stale position under a promise the customer has
 * since been told about, and never on a day that changed under it between
 * the pre-write read and the write itself. BEFORE that write, the order
 * dispatch will read after the restore is run through the SHARED guard,
 * chooseWindowSafeOrder itself (certification incl. coordinates, then
 * chronology + drive-time feasibility), and only an order it certifies as
 * is may be written: windows
 * can change since a backup with route_order left untouched, and restoring
 * the old position under the new windows could otherwise put an afternoon
 * promise before a morning one. Everything the writer or this legality
 * check refuses is reported as a skipped (or, for an unreadable
 * reminder-freeze status, failed) tech-day with its reason — never a
 * partial day, since the writer itself is one all-or-nothing transaction
 * per tech-day.
 *
 * Serializes with the 4:20 ET nightly pass by taking its OWN lock
 * (runExclusive('auto-dispatch-recurring') — server/utils/cron-lock.js is a
 * plain Postgres pg_try_advisory_lock, usable from any script holding a DB
 * connection) rather than a second, parallel mechanism; a run that finds
 * the lock held refuses outright rather than racing the nightly write.
 *
 * ids-only output throughout — no customer name, address, or phone number
 * is ever read or printed here.
 *
 * Usage (repo root) — run against the PORTAL service, NOT `--service
 * Postgres`: the reorder pass reads GATE_ROUTE_REORDER*, GATE_DRIVE_TIME_
 * CALIBRATION and GOOGLE_MAPS_API_KEY, none of which a Postgres-only
 * `railway run` injects, so a Postgres-service run would silently stand
 * down Google/window-fit and canonicalize with the fallback-less baseline
 * only:
 *   railway run node scripts/route-order-cleanup.js                       # dry run, D+3..D+30 ET
 *   railway run node scripts/route-order-cleanup.js --execute
 *   railway run node scripts/route-order-cleanup.js --from 2026-10-01 --to 2026-10-15
 *   railway run node scripts/route-order-cleanup.js --execute --out backup.json
 *   railway run node scripts/route-order-cleanup.js --rollback backup.json            # dry run
 *   railway run node scripts/route-order-cleanup.js --rollback backup.json --execute
 *
 * Under `railway run`, Railway injects the linked (portal) service's env
 * before the process starts — dotenv.config() below is a no-op then and
 * only fills gaps for a bare local run (same pattern as the other
 * scripts/*.js one-shots).
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// A selector flag with no value must fail, never silently widen the range
// or skip the rollback file (same guard recurring-series-topup.js uses).
for (const flag of ['--from', '--to', '--out', '--rollback']) {
  if (!args.includes(flag)) continue;
  const v = argValue(flag);
  if (v == null || v.startsWith('--')) {
    console.error(`Missing value for ${flag}.`);
    process.exit(1);
  }
}

const FROM_ARG = argValue('--from');
const TO_ARG = argValue('--to');
const OUT_PATH = argValue('--out');
const ROLLBACK_PATH = argValue('--rollback');

/**
 * Inclusive list of YYYY-MM-DD ET calendar dates from `from` to `to`.
 * Bounded at 60 days (the widest a --from/--to an operator could sensibly
 * want here, and comfortably above the D+3..D+30 default) so a reversed or
 * mistyped range fails fast instead of building an unbounded array.
 */
function buildDateRange(from, to, { addETDays, etDateString, parseETDateTime }) {
  if (!(from <= to)) return { error: `--from (${from}) must not be after --to (${to}).` };
  const dates = [];
  let cursor = from;
  for (let i = 0; i < 61; i++) {
    if (cursor > to) return { dates };
    dates.push(cursor);
    cursor = etDateString(addETDays(parseETDateTime(`${cursor}T00:00`), 1));
  }
  return { error: `--from/--to spans more than 60 days (${from}..${to}) — narrow the range.` };
}

/**
 * The exact opts object passed to runRouteReorder for the forward
 * (non-rollback) run. `now` is threaded through ONLY for a dry run:
 * runRouteReorder's own opts.now, when set, pins BOTH the load-time freeze
 * check AND the commit-time re-check (writeTechDayOrder's `commitNow =
 * opts.now || new Date()`) to that ONE instant for the run's ENTIRE
 * duration — a live --execute run can take minutes (Google Maps calls, DB
 * round trips across many dates), so a tech-day that crosses the 72h
 * freeze boundary WHILE the script is still working through an earlier
 * date would still pass its commit-time re-check under the stale clock and
 * get WRITTEN after it should have frozen (codex pre-push P1). Omitting
 * `now` for --execute lets every internal `opts.now || new Date()` read
 * the REAL wall clock fresh at each check, exactly like the nightly cron.
 * A dry run never commits anything (writeTechDayOrder is never called), so
 * pinning its clock is safe and keeps one consistent preview across the
 * whole date range.
 */
function buildRunOpts({ execute, dates, now, runType }) {
  return {
    canonicalizeStale: true,
    dates,
    dryRun: !execute,
    runType,
    ...(execute ? {} : { now }),
  };
}

/**
 * The dates a --from/--to range would have runRouteReorder's own
 * boundedDateList SILENTLY DROP: canonicalize mode only ever honors D+1..
 * D+30 ET (today exclusive, `lastDate` inclusive) — a wider or
 * today-or-earlier request previously just vanished from the run with no
 * indication anything was skipped (codex pre-push P2). Checked here so the
 * script refuses with a clear error instead of quietly doing less than
 * asked.
 */
function outOfHorizonDates(dates, today, lastDate) {
  return dates.filter((date) => !(date > today && date <= lastDate));
}

/** True when runRouteReorder's own result signals a problem — a hard
 *  failure, a degraded run (some tech-day tripped a fail-closed guard), or
 *  a nonzero failed count — independent of whether the backup/report stage
 *  afterward succeeds (codex pre-push P2: the script only ever went
 *  nonzero for a lost backup, never for the run itself reporting
 *  unhealthy). Both a dry run and an --execute run carry `status`; only
 *  --execute's result shape also carries the `failed` COUNT (a dry run
 *  attempts no writes to fail). */
function runIsUnhealthy(result) {
  return result.status === 'failed' || result.status === 'completed_with_errors' || (result.failed || 0) > 0;
}

/** Flatten runRouteReorder's per-tech-day entries (the dry-run `plan` array,
 *  or reorder rows read back from the ledger after --execute) into the
 *  backup file's per-ROW shape: {id, date, technician_id, before, after}.
 *  A day with no route_order_changes (skipped, or nothing actually moved)
 *  contributes nothing. */
function buildBackupRows(entries) {
  return (entries || []).flatMap((entry) => (entry.route_order_changes || []).map((change) => ({
    id: change.id,
    date: entry.date,
    technician_id: entry.technicianId ?? entry.technician_id ?? null,
    before: change.before,
    after: change.after,
  })));
}

/** One line per touched tech-day, ids only. */
function printPlan(entries) {
  const touched = (entries || []).filter((entry) => (entry.route_order_changes || []).length > 0);
  if (!touched.length) {
    console.log('No tech-day needs a route_order change in this range.');
    return;
  }
  for (const entry of touched) {
    const tag = entry.canonicalized
      ? `canonicalized (reasons=${JSON.stringify(entry.canonicalized.reasons)}, source=${entry.canonicalized.source})`
      : `reordered (source=${entry.source || 'unknown'})`;
    console.log(`${entry.date} tech ${entry.technicianId ?? entry.technician_id}: ${entry.route_order_changes.length} stop(s) ${tag}`);
  }
}

/** Backup rows grouped into one entry per (technician_id, date) — the unit
 *  the rollback (and its dry-run preview) both operate on. */
function groupRowsByTechDay(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.technician_id}:${row.date}`;
    if (!byKey.has(key)) byKey.set(key, { technician_id: row.technician_id, date: row.date, rows: [] });
    byKey.get(key).rows.push(row);
  }
  return [...byKey.values()];
}

/**
 * The full live tech-day, re-read fresh — the ONLY state a rollback write
 * needs to hand writeTechDayOrder as its comparison snapshot ("an ordinary
 * write with expected snapshot = live day"). Same scope (exact date +
 * technician, not excluded, not an expired hold) and the same guard
 * columns/coordinates the writer's OWN internal re-read selects — built
 * from the writer's exported building blocks (`ROUTE_WRITE_GUARD_COLUMNS`,
 * `CUSTOMER_PREMISE_ALIASES`, `guardedCoordSelects`, `EXCLUDE_STATUSES`,
 * `LIVE_HOLD_SQL`, all threaded through `deps`) rather than a second,
 * drift-prone copy of that shape. `forUpdate: true` locks the rows — used
 * only inside the writer's own transaction (it re-reads the day itself);
 * the caller here always reads unlocked, since neither the dry-run preview
 * nor the pre-write mismatch check opens a transaction of its own.
 */
function readLiveTechDay(conn, { dateStr, techId, forUpdate = false }, deps) {
  const { EXCLUDE_STATUSES, LIVE_HOLD_SQL, ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES, guardedCoordSelects } = deps;
  const query = conn('scheduled_services')
    .where('scheduled_services.scheduled_date', dateStr)
    .where('scheduled_services.technician_id', techId)
    .whereNotIn('scheduled_services.status', EXCLUDE_STATUSES)
    .whereRaw(LIVE_HOLD_SQL)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id',
      ...ROUTE_WRITE_GUARD_COLUMNS.map((col) => `scheduled_services.${col}`),
      // currentOrder's last tie-break (COALESCE(route_order, 999),
      // window_start, created_at) — the rollback's legality check runs over
      // the order dispatch will actually READ (restoredDispatchOrder).
      'scheduled_services.created_at',
      ...CUSTOMER_PREMISE_ALIASES,
      ...guardedCoordSelects(conn),
    );
  return forUpdate ? query.forUpdate('scheduled_services') : query;
}

/**
 * The pure "does the backup still match" check — all that's left of the
 * old hand-rolled eligibility logic. `liveRows` is already scoped to this
 * EXACT (date, technician_id) by readLiveTechDay, so a row reassigned to a
 * different tech-day since the backup needs no separate date/technician
 * compare: it is simply ABSENT from `liveRows` (id missing), never a
 * same-route_order coincidence silently matching the wrong day (the
 * original codex P1 this check fixed). Freeze/lock/today-past eligibility
 * is deliberately NOT checked here any more — that logic now lives in
 * exactly one place, inside writeTechDayOrder, re-checked against a
 * FRESHER read than this function ever sees.
 */
function mismatchedIdsForDay(dayRows, liveRows) {
  const liveById = new Map(liveRows.map((row) => [row.id, row]));
  return dayRows.filter((row) => {
    const live = liveById.get(row.id);
    return !live || Number(live.route_order) !== Number(row.after);
  }).map((row) => row.id);
}

/**
 * Reconstructs the day's ORIGINAL (pre-cleanup) order — a pure SORT by each
 * row's original position, never a splice-by-index (codex pre-push P1: the
 * previous version treated a backed-up row's `before` as a literal array
 * position to insert at, and left a NULL-before row wherever it happened to
 * sit in the CURRENT live order instead of the "no original position —
 * unpositioned, sorts LAST" that a null route_order means everywhere else
 * in this codebase, e.g. `COALESCE(route_order, 999)`. Repro: original
 * A=2,B=3,C=null → cleanup wrote B=1,C=2,A=3 → the old code restored
 * C,A,B instead of A,B,C).
 *
 * Every row's original position is knowable with NO backup-format change:
 *   - a BACKED-UP row's (one in `dayRows`) original position is its
 *     recorded `before` — or, `before: null`/non-numeric, "no original
 *     position", sorting after every numbered one.
 *   - a NON-backed-up row's original position is simply its CURRENT
 *     route_order: cleanup never wrote it, so before-the-run and now are
 *     the same value by definition (and if some OTHER writer moved it
 *     since the backup, the fenced writer's own fresh re-read/signature
 *     compare catches that drift at commit time, exactly like any other
 *     row — this function only has to get the TARGET order right).
 * Sorting the whole day by that one key reconstructs the exact original
 * sequence in one pass; ties (including several null-before rows) break on
 * the CURRENT live order — a stable, deterministic fallback, never a
 * clamped guess at an array index.
 */
function buildRollbackTargetOrder(liveRows, dayRows) {
  const liveSorted = [...liveRows].sort((a, b) => {
    const ao = a.route_order == null ? Infinity : Number(a.route_order);
    const bo = b.route_order == null ? Infinity : Number(b.route_order);
    return ao - bo;
  });
  const beforeById = new Map(dayRows.map((row) => [row.id, row.before]));
  const originalPosition = (row) => {
    const raw = beforeById.has(row.id) ? beforeById.get(row.id) : row.route_order;
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : Infinity;
  };
  return liveSorted
    .map((row, liveIdx) => ({ row, key: originalPosition(row), liveIdx }))
    .sort((a, b) => (a.key - b.key) || (a.liveIdx - b.liveIdx))
    .map((entry) => entry.row);
}

/**
 * The EXACT route_order value every row on the day goes back to — handed to
 * writeTechDayOrder as `opts.positions`, its explicit-positions mode, so the
 * rollback writes back what was recorded instead of renumbering the day by
 * index+1 (codex thread "Preserve null-position rows when reconstructing
 * rollback order": original 4,5,null must come back as 4,5,null, never
 * 1,2,3). A backed-up row returns to its recorded `before` (null stays
 * null; a non-numeric value is treated as null, the same "no position" it
 * sorts as in buildRollbackTargetOrder). A row the cleanup never touched
 * keeps its CURRENT value — it is rewritten to itself, so the writer's
 * per-row CAS still covers it.
 */
function buildRollbackPositions(liveRows, dayRows) {
  const toPosition = (raw) => {
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) ? n : null;
  };
  const beforeById = new Map(dayRows.map((row) => [row.id, row.before]));
  return new Map(liveRows.map((row) => [
    row.id,
    toPosition(beforeById.has(row.id) ? beforeById.get(row.id) : row.route_order),
  ]));
}

/**
 * The order dispatch will actually READ once the rollback commits: copies of
 * the live rows carrying the exact restored positions, sorted by the SAME
 * currentOrder every reader uses (COALESCE(route_order, 999), window_start,
 * created_at, id). Restored ties — duplicate positions, or several rows
 * restored to null — are resolved by that sort, NOT by the rollback's own
 * target sequence: two time_window-only rows restored to null have no
 * window_start, so dispatch orders them by created_at, and an afternoon row
 * created first reads BEFORE the morning one (codex pre-push P1). The
 * window-legality check runs over this order, never the target sequence.
 */
function restoredDispatchOrder(liveRows, positions, deps) {
  return deps.currentOrder(liveRows.map((row) => ({ ...row, route_order: positions.get(row.id) })));
}

/**
 * The rollback's legality verdict — the SHARED guard itself,
 * chooseWindowSafeOrder (via `deps`), called the way the forward pass calls
 * it, over `targetOrder` = the exact order dispatch will read once the
 * restore commits (restoredDispatchOrder) — never hand-rolled checks of our
 * own (codex pre-push P1: calling violatesWindowFeasibility directly skipped
 * the guard's COORDLESS_STOPS refusal, so a coordless stop's travel counted
 * as zero and an undrivable restore could pass). Windows can change after a
 * backup was taken with route_order left alone — restoring the OLD position
 * under the NEW windows could put an afternoon promise before a morning one.
 * `liveRows` doubles as both the guard's window/coordinate source AND the
 * writer's comparison snapshot — the SAME live read, never a second one.
 *
 * Returns null ONLY when the guard certifies that exact order as is — a
 * window-fit repair it proposes instead is never accepted (the rollback
 * restores recorded positions or nothing). Otherwise the guard's reason:
 * an uncertifiable day's reason (COORDLESS_STOPS, …) first — the day can't
 * be judged at all — then the order's own conflict (WINDOW_ORDER_CONFLICT /
 * WINDOW_FIT_CONFLICT).
 */
function rollbackWindowConflict(targetOrder, liveRows, deps) {
  const { RouteOptimizer, chooseWindowSafeOrder, UNCERTIFIABLE_REASONS } = deps;
  const guard = chooseWindowSafeOrder({
    RouteOptimizer, googleOrder: targetOrder, sourceStops: liveRows, googleSource: 'rollback',
  });
  if (UNCERTIFIABLE_REASONS.has(guard.reason)) return guard.reason;
  if (guard.conflict) return guard.conflict;
  const certifiedIds = (guard.orderedStops || []).map((s) => s.id).join(',');
  if (certifiedIds !== targetOrder.map((s) => s.id).join(',')) return guard.reason || 'UNCERTIFIED_ORDER';
  return null;
}

/**
 * Ids of every live row that would SHARE a non-null route_order once the
 * restore commits, where that sharing was not already in the backup's
 * before-state (codex PRRT_kwDOR3YQi86mQfEB). The mismatch check only
 * covers BACKED-UP rows; an unbacked row can be moved since the backup (an
 * admin single-row reorder) onto a slot a backed-up row is about to be
 * restored to — restore A→2 while unbacked X is now 2 leaves both at 2,
 * and the window guard can still approve that order. A shared position is
 * accepted only when every row in it is backed up AND their recorded
 * `before` values were equal (a duplicate the day genuinely had before the
 * cleanup); any group containing an unbacked row, or restored rows whose
 * shared value was not a before-state duplicate, collides. Empty = none.
 */
function restorePositionCollisions(liveRows, dayRows, positions) {
  const backedUp = new Set(dayRows.map((row) => row.id));
  const byPosition = new Map();
  for (const row of liveRows) {
    const pos = positions.get(row.id);
    if (pos == null) continue;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(row.id);
  }
  // Every value in `positions` for a backed-up row IS its recorded before,
  // so an all-backed-up group sharing a position was a before-state duplicate.
  const collides = (ids) => ids.length > 1 && ids.some((id) => !backedUp.has(id));
  return [...byPosition.values()].filter(collides).flat().sort();
}

/**
 * The full pre-write verdict for one backed-up tech-day whose rows all still
 * match the backup — shared by the dry-run preview and the real rollback so
 * both report the same thing: the exact positions to restore, and why the
 * day must be skipped (null = restorable): RESTORE_POSITION_COLLISION first
 * (with `collisionIds`), then the shared guard's verdict on the order
 * dispatch will read (rollbackWindowConflict).
 */
function restoreVerdict(liveRows, dayRows, deps) {
  const positions = buildRollbackPositions(liveRows, dayRows);
  const collisionIds = restorePositionCollisions(liveRows, dayRows, positions);
  if (collisionIds.length) return { positions, conflict: 'RESTORE_POSITION_COLLISION', collisionIds };
  // Legality is checked on the order dispatch will READ after the commit
  // (restoredDispatchOrder) — with explicit positions the writer's row
  // sequence never decides how ties are read back.
  const conflict = rollbackWindowConflict(restoredDispatchOrder(liveRows, positions, deps), liveRows, deps);
  return { positions, conflict, collisionIds };
}

/** Operator-facing explanation for a restoreVerdict conflict. */
function rollbackConflictDetail(conflict, collisionIds = []) {
  if (conflict === 'RESTORE_POSITION_COLLISION') {
    return `restored positions would collide with rows moved since the backup (ids only): ${collisionIds.join(', ')}`;
  }
  return conflict.startsWith('WINDOW_')
    ? 'the restored order would violate a promised window — windows likely changed since the backup'
    : 'the shared route guard cannot certify the restored order (e.g. a stop without usable coordinates)';
}

/**
 * Read-only preview for `--rollback <file>` WITHOUT --execute: reads each
 * backed-up tech-day's CURRENT live state (unlocked, no transaction —
 * nothing here can ever write) and reports the SAME "does the backup still
 * match" check AND the same window-legality check the real rollback runs
 * before ever calling the writer. Freeze/lock/today-past eligibility is not
 * checked here at all — a would-restore day's `note` says so plainly rather
 * than promising a write that the writer's own fresher re-check could still
 * refuse.
 */
async function previewRollback(conn, rows, deps) {
  const days = groupRowsByTechDay(rows);
  const plan = [];
  for (const day of days) {
    const liveRows = await readLiveTechDay(conn, { dateStr: day.date, techId: day.technician_id }, deps);
    const mismatchedIds = mismatchedIdsForDay(day.rows, liveRows);
    const verdict = mismatchedIds.length ? { conflict: null, collisionIds: [] } : restoreVerdict(liveRows, day.rows, deps);
    const { conflict } = verdict;
    const wouldRestore = mismatchedIds.length === 0 && !conflict;
    plan.push({
      technician_id: day.technician_id,
      date: day.date,
      row_count: day.rows.length,
      would_restore: wouldRestore,
      mismatched_ids: mismatchedIds,
      conflict,
      ...(verdict.collisionIds.length ? { collision_ids: verdict.collisionIds } : {}),
      note: wouldRestore ? 'eligibility (freeze/lock/today-past) re-checked at write time' : null,
    });
  }
  return plan;
}

/**
 * Rollback: for each backed-up tech-day, re-read the full live day and, if
 * every backed-up row still matches its backup `after` (mismatchedIdsForDay
 * — computed BEFORE the writer is ever called, so a mismatching day never
 * even attempts a write) AND the restored order passes the same window
 * legality guards the forward pass certifies an order with
 * (rollbackWindowConflict — a day whose windows changed since the backup
 * with route_order left alone is skipped here too, never handed to the
 * writer), hand the SAME fenced writer every other route_order write goes
 * through (`deps.writeTechDayOrder` — writeTechDayOrder / runRouteReorder's
 * own writer) an ORDINARY write: techStops = the live read just taken (the
 * writer's own comparison snapshot — "expected snapshot = live day"),
 * finalOrdered = buildRollbackTargetOrder's restored sequence, and
 * opts.positions = buildRollbackPositions's exact recorded values (the
 * writer's explicit-positions mode — never an index+1 renumber). The writer
 * re-reads the day itself under its own advisory lock, inside its own
 * SERIALIZABLE transaction, FOR UPDATE — compares against that snapshot,
 * re-checks freeze/lock/today-past with a FRESH clock at commit time, and
 * CAS-updates row by row. Every one of those guards now lives in EXACTLY
 * ONE place, never duplicated here. Anything the writer refuses is
 * classified by `deps.classifyWriteError` — the SAME classifier
 * runRouteReorder's own per-tech loop uses — into this run's
 * skipped/failed report; a pre-write mismatch or window conflict is
 * reported the same way. No outer transaction or lock wraps this loop:
 * each `writeTechDayOrder` call is already its own complete, independently
 * fenced unit of work, exactly like the forward per-tech-day loop that
 * calls it — there is no longer a separate rollback-only locking mechanism
 * to keep in sync with the writer's.
 */
async function applyRollback(conn, rows, now, deps) {
  const summary = { skipped: [], failed: [] };
  let restored = 0;
  if (!rows.length) return { restored, summary };
  const days = groupRowsByTechDay(rows);
  for (const day of days) {
    const entryBase = { date: day.date, technician_id: day.technician_id };
    const liveRows = await readLiveTechDay(conn, { dateStr: day.date, techId: day.technician_id }, deps);
    const mismatchedIds = mismatchedIdsForDay(day.rows, liveRows);
    if (mismatchedIds.length) {
      summary.skipped.push({
        ...entryBase,
        reason: 'MISMATCH',
        detail: `no longer matches the backup (ids only): ${mismatchedIds.join(', ')}`,
        mismatched_ids: mismatchedIds,
      });
      continue;
    }
    const finalOrdered = buildRollbackTargetOrder(liveRows, day.rows);
    const { positions, conflict, collisionIds } = restoreVerdict(liveRows, day.rows, deps);
    if (conflict) {
      summary.skipped.push({
        ...entryBase,
        reason: conflict,
        detail: rollbackConflictDetail(conflict, collisionIds),
        ...(collisionIds.length ? { collision_ids: collisionIds } : {}),
      });
      continue;
    }
    try {
      await deps.writeTechDayOrder(conn, {
        dateStr: day.date, techId: day.technician_id, techStops: liveRows, finalOrdered,
        repair: null, opts: { positions }, now, repairGates: [],
      });
      restored += day.rows.length;
    } catch (writeErr) {
      deps.classifyWriteError(writeErr, { summary, entryBase });
    }
  }
  return { restored, summary };
}

/** One line per tech-day for the dry-run --rollback preview, ids only. */
function printRollbackPlan(plan) {
  for (const day of plan) {
    if (day.would_restore) {
      console.log(`${day.date} tech ${day.technician_id}: would restore ${day.row_count} row(s) (${day.note})`);
    } else if (day.conflict) {
      console.log(`${day.date} tech ${day.technician_id}: WOULD SKIP — ${day.conflict} (${rollbackConflictDetail(day.conflict, day.collision_ids)})`);
    } else {
      console.log(`${day.date} tech ${day.technician_id}: WOULD SKIP (${day.mismatched_ids.length} row(s) no longer match, ids only): ${day.mismatched_ids.join(', ')}`);
    }
  }
}

/** One line per tech-day for the real --rollback --execute outcome, ids only.
 *  A skipped entry (classifyWriteError's quiet-skip branches, or a pre-write
 *  mismatch) carries its explanation as `detail`; a failed entry
 *  (REMINDER_GUARD_OUTAGE, fail-closed) carries it as `error` — printed the
 *  same way either way. */
function printRollbackResult(result, totalRows) {
  console.log(`Restored ${result.restored}/${totalRows} row(s).`);
  const skippedAll = [...result.summary.skipped, ...result.summary.failed];
  if (skippedAll.length) {
    console.log(`${skippedAll.length} tech-day(s) skipped:`);
    for (const day of skippedAll) {
      const detail = day.detail || day.error;
      console.log(`  ${day.date} tech ${day.technician_id}: ${day.reason}${detail ? ` — ${detail}` : ''}`);
    }
  }
}

/** route_optimization_planner_runs.result is jsonb — pg/knex hands back an
 *  already-parsed OBJECT on a read-back, never a string (only the WRITE side,
 *  writeLedgerRow, passes a JSON.stringify'd string INTO the insert; postgres
 *  stores it as jsonb and returns it parsed). JSON.parse'ing an object throws
 *  ("[object Object]" is not valid JSON) — accept a string only via a
 *  typeof check, exactly like every other jsonb column this codebase reads
 *  back (codex pre-push P1: this crashed --out AFTER the live writes had
 *  already committed). */
function parseLedgerResult(raw) {
  if (raw == null) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** Printed whenever the writes already committed but this script could not
 *  finish reporting/backing them up — the backup must never look silently
 *  lost. The ledger row is the source of truth either way: every
 *  canonicalized/reordered entry's route_order_changes ({id, before, after})
 *  plus its date/technicianId is exactly the backup file's row shape. */
function recoveryInstruction(ledgerId) {
  return `The route_order writes for this run ALREADY COMMITTED${ledgerId ? ` (ledger id ${ledgerId})` : ''}. `
    + 'Recovery: read route_optimization_planner_runs.result.reorders for that ledger id — each entry\'s '
    + 'route_order_changes ([{id,before,after}]) plus its date/technicianId is exactly the backup file\'s row '
    + 'shape; rebuild --out by hand from those, or re-run with --out once the ledger is reachable again.';
}

/** True when an entry actually carries committed row changes — the only
 *  thing that makes it useful for the backup file. */
function hasChanges(entry) {
  return (entry.route_order_changes || []).length > 0;
}

/** Total row changes across a list of per-tech-day entries — the cross-check
 *  metric collectEntries compares primary against the ledger with. */
function totalChanges(entries) {
  return entries.reduce((n, entry) => n + (entry.route_order_changes || []).length, 0);
}

/** The per-tech-day entries to report/back up: the dry-run plan directly, or
 *  (--execute) the run's OWN return value — runRouteReorder now carries the
 *  ACTUAL committed route_order_changes it wrote directly on its result
 *  (canonicalizeStale mode only: `result.appliedChanges`). That direct
 *  evidence is PRIMARY and is what the backup is built from; the ledger row
 *  is read only as a best-effort CROSS-CHECK (it is written from the exact
 *  same in-memory evidence, so a mismatch here would mean something is
 *  actually wrong, not a normal race) and, for every (date, technician) it
 *  also recorded, supplies the richer canonicalized-reasons/source detail
 *  the printed plan shows — primary's own row_order_changes are never
 *  replaced by this merge, only the reporting-only fields. A ledger
 *  insert failure, a read-back failure, or a null ledgerId (codex pre-push
 *  P1: previously read as "nothing applied" and silently produced an empty
 *  backup) never blocks the backup as long as `appliedChanges` has it —
 *  only when NEITHER source has any row changes, despite `result.applied`
 *  saying tech-days were applied, is this an `error`: the caller refuses to
 *  write an empty backup and exits nonzero. */
async function collectEntries(db, execute, result) {
  if (!execute) return { entries: result.plan || [], error: null };
  const primary = (result.appliedChanges || []).map((entry) => ({
    date: entry.date, technicianId: entry.technicianId, route_order_changes: entry.changes || [],
  }));
  let ledgerEntries = [];
  try {
    const ledgerRow = result.ledgerId
      ? await db('route_optimization_planner_runs').where({ id: result.ledgerId }).first('result')
      : null;
    ledgerEntries = ledgerRow ? (parseLedgerResult(ledgerRow.result).reorders || []) : [];
  } catch {
    ledgerEntries = []; // cross-check only — a read failure never blocks the backup
  }
  // Only a genuine DISAGREEMENT is worth a warning — primary being simply
  // absent (an older/unexpected result shape falling back to the ledger
  // alone) is normal and not a mismatch.
  if (primary.length > 0 && ledgerEntries.length > 0 && totalChanges(primary) !== totalChanges(ledgerEntries)) {
    console.error(`Warning: the run's own result reports ${totalChanges(primary)} row change(s) but the ledger reports ${totalChanges(ledgerEntries)} — using the run's own result for the backup.`);
  }
  // Primary wins whenever it has anything (its route_order_changes are the
  // backup's row evidence, never overwritten) — but primary's own shape
  // carries no `canonicalized`/`source` detail, only the raw changes, so
  // printPlan would otherwise report every day as a bare "reordered
  // (source=unknown)" even though the ledger recorded richer per-day
  // evidence for the SAME run. Merge that reporting-only metadata in by
  // (date, technician) match; the ledger is used only when primary is
  // empty (an older/unexpected result shape) and it still has real
  // evidence.
  const ledgerKey = (e) => `${e.date}:${e.technicianId ?? e.technician_id}`;
  const ledgerByKey = new Map(ledgerEntries.map((e) => [ledgerKey(e), e]));
  const entries = primary.length > 0
    ? primary.map((entry) => {
      const match = ledgerByKey.get(ledgerKey(entry));
      if (!match) return entry;
      return {
        ...entry,
        ...(match.canonicalized !== undefined ? { canonicalized: match.canonicalized } : {}),
        ...(match.source !== undefined ? { source: match.source } : {}),
      };
    })
    : ledgerEntries;
  if ((result.applied || 0) > 0 && !entries.some(hasChanges)) {
    return {
      entries: [],
      error: new Error(`runRouteReorder reported ${result.applied} applied tech-day(s) but neither its own result nor the ledger carried any route_order_changes`),
    };
  }
  return { entries, error: null };
}

/** Writes the backup JSON to a `.tmp` sibling first, then renames it into
 *  place — a POSIX rename is atomic, so a write that fails partway (or the
 *  process dying mid-write) never touches an EXISTING backup file at
 *  `outPath`; the old file survives untouched either way. */
function writeBackupFile(outPath, rows) {
  const resolved = path.resolve(outPath);
  const tmpPath = `${resolved}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
  fs.renameSync(tmpPath, resolved);
}

/** Prints the plan and (with --out) writes the backup file — or, on any
 *  failure at this stage, prints recoveryInstruction instead of leaving the
 *  operator to guess whether an --execute run's writes are backed up.
 *  Never writes an empty/partial backup file after a read failure — that
 *  would look like a clean "nothing changed" file instead of a missing one.
 *  Returns `{ backupFailed }` so the caller can exit nonzero when a
 *  --execute run's writes committed but the backup that was supposed to
 *  protect them could not be written (codex pre-push P1: this used to be
 *  swallowed here and the process exited 0). */
function reportAndBackup({ execute, result, entries, error, outPath }) {
  if (error) {
    console.error(`Could not read back the ledger row for reporting/backup (${error.message}).`);
    console.error(recoveryInstruction(result.ledgerId));
  } else {
    printPlan(entries);
  }
  if (!outPath) return { backupFailed: false };
  if (error) {
    console.error(`Refusing to write ${outPath} — the ledger could not be read back (see above). ${recoveryInstruction(result.ledgerId)}`);
    return { backupFailed: false };
  }
  try {
    const rows = buildBackupRows(entries);
    writeBackupFile(outPath, rows);
    console.log(`\nWrote ${rows.length} row(s) to ${outPath}.`);
    return { backupFailed: false };
  } catch (err) {
    console.error(`Failed to write backup file ${outPath}: ${err.message}`);
    if (execute) console.error(recoveryInstruction(result.ledgerId));
    return { backupFailed: true };
  }
}

/** True when an executed rollback did not restore everything it was asked
 *  to: fewer rows restored than the backup holds, or any tech-day skipped or
 *  failed. The script then exits nonzero (codex PRRT_kwDOR3YQi86mQTCz) — a
 *  partial rollback must never read as success to an operator or a wrapper. */
function rollbackIsIncomplete(result, totalRows) {
  return result.restored < totalRows
    || result.summary.skipped.length > 0
    || result.summary.failed.length > 0;
}

/**
 * `--rollback <file>`: returns the process exit code (0 = clean). A dry run
 * (the default) previews with no lock, no transaction, nothing that can
 * write. `--execute` runs under the SAME run-level lock the forward cleanup
 * and the nightly auto-dispatch/route-reorder pass hold —
 * runExclusive('auto-dispatch-recurring'), fail-fast (codex
 * PRRT_kwDOR3YQi86mQTC6): a rollback racing the nightly pass could restore
 * a day's old positions while that pass is mid-way through rewriting its
 * neighbors. A held lock refuses the whole rollback (exit 1, nothing
 * written); wasLockSkipped reads only the lock machinery's own refusal
 * shape, never applyRollback's result.
 */
async function runRollback(db, backupPath, execute, now, deps) {
  const raw = fs.readFileSync(path.resolve(backupPath), 'utf8');
  const backup = JSON.parse(raw);
  const rows = Array.isArray(backup.rows) ? backup.rows : [];
  if (!rows.length) {
    console.log('Backup file has no rows — nothing to roll back.');
    return 0;
  }
  if (!execute) {
    console.log(`DRY RUN — would roll back ${rows.length} row(s) from ${backupPath} (generated_at=${backup.generated_at || 'unknown'})\n`);
    printRollbackPlan(await previewRollback(db, rows, deps));
    console.log('\nDry run only — nothing was written. Pass --rollback <file> --execute to commit.');
    return 0;
  }
  console.log(`EXECUTING — rolling back ${rows.length} row(s) from ${backupPath} (generated_at=${backup.generated_at || 'unknown'})\n`);
  const result = await deps.runExclusive('auto-dispatch-recurring', () => applyRollback(db, rows, now, deps),
    { recordHealth: false, waitForSlot: false });
  if (deps.wasLockSkipped(result)) {
    console.error(`Refused to roll back — the nightly auto-dispatch/route-reorder lock is held (${result.reason}). Nothing was written. Try again shortly.`);
    return 1;
  }
  printRollbackResult(result, rows.length);
  return rollbackIsIncomplete(result, rows.length) ? 1 : 0;
}

async function main() {
  const db = require('../server/models/db');
  const { runExclusive, wasLockSkipped } = require('../server/utils/cron-lock');

  if (ROLLBACK_PATH) {
    // Rollback goes through the exact same fenced writer (writeTechDayOrder)
    // and error classifier (classifyWriteError) every other route_order
    // write in the app uses — these `deps` are the writer's own exported
    // building blocks, never a second copy of its guards.
    const {
      writeTechDayOrder, classifyWriteError, ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES,
      chooseWindowSafeOrder, _internals: { EXCLUDE_STATUSES, LIVE_HOLD_SQL, UNCERTIFIABLE_REASONS, currentOrder },
    } = require('../server/services/route-reorder');
    const { guardedCoordSelects } = require('../server/services/scheduling/day-stops');
    const RouteOptimizer = require('../server/services/route-optimizer');
    const rollbackDeps = {
      writeTechDayOrder, classifyWriteError,
      ROUTE_WRITE_GUARD_COLUMNS, CUSTOMER_PREMISE_ALIASES, guardedCoordSelects,
      EXCLUDE_STATUSES, LIVE_HOLD_SQL,
      RouteOptimizer, chooseWindowSafeOrder, UNCERTIFIABLE_REASONS, currentOrder,
      runExclusive, wasLockSkipped,
    };
    process.exitCode = await runRollback(db, ROLLBACK_PATH, EXECUTE, new Date(), rollbackDeps);
    await db.destroy();
    return;
  }

  const { etDateString, addETDays, parseETDateTime, validCalendarDate } = require('../server/utils/datetime-et');
  const now = new Date();
  const from = FROM_ARG || etDateString(addETDays(now, 3));
  const to = TO_ARG || etDateString(addETDays(now, 30));
  if (!validCalendarDate(from) || !validCalendarDate(to)) {
    console.error(`Invalid --from/--to: "${from}".."${to}" — must be YYYY-MM-DD.`);
    process.exit(1);
  }
  const range = buildDateRange(from, to, { addETDays, etDateString, parseETDateTime });
  if (range.error) {
    console.error(range.error);
    process.exit(1);
  }

  // runRouteReorder's canonicalize mode only ever honors D+1..D+30 ET —
  // anything outside that (today/past, or past D+30) is silently dropped
  // BY THE WRITER, not rejected; refuse it here instead of quietly running
  // a narrower range than what was asked for.
  const horizonToday = etDateString(now);
  const horizonLastDate = etDateString(addETDays(now, 30));
  const outOfHorizon = outOfHorizonDates(range.dates, horizonToday, horizonLastDate);
  if (outOfHorizon.length) {
    console.error(`--from/--to includes date(s) outside the runnable D+1..${horizonLastDate} ET horizon (would be silently dropped otherwise): ${outOfHorizon.join(', ')}.`);
    process.exit(1);
  }

  console.log(`${EXECUTE ? 'EXECUTING' : 'DRY RUN'} — route-order cleanup ${from}..${to} (${range.dates.length} day${range.dates.length === 1 ? '' : 's'})\n`);

  const { runRouteReorder } = require('../server/services/route-reorder');
  const runOpts = buildRunOpts({ execute: EXECUTE, dates: range.dates, now, runType: 'route_order_cleanup' });
  const lockResult = await runExclusive('auto-dispatch-recurring', () => runRouteReorder(runOpts),
    { recordHealth: false, waitForSlot: false });

  // wasLockSkipped, not a bare `lockResult.skipped` truthiness check: a
  // SUCCESSFUL --execute run's own return carries `skipped` as a NUMBER
  // (the count of skipped tech-days, routinely > 0), and the dry-run shape
  // has no `skipped` key at all — either reads truthy under a naive check
  // and reports "lock refused" on a run that actually wrote (or planned)
  // just fine, exiting before --out ever runs (codex pre-push P1).
  // wasLockSkipped requires the MACHINERY's own `{ skipped: true, reason:
  // 'lease_held' | 'no_connection' }` shape, which only runExclusive itself
  // returns when it never invoked the callback at all.
  if (wasLockSkipped(lockResult)) {
    console.error(`Refused to run — the nightly auto-dispatch/route-reorder lock is held (${lockResult.reason}). Try again shortly.`);
    await db.destroy();
    process.exit(1);
  }

  const result = lockResult;
  console.log(EXECUTE
    ? `status=${result.status} applied=${result.applied} skipped=${result.skipped} failed=${result.failed} ledger=${result.ledgerId ?? 'none'}\n`
    : `status=${result.status}\n`);

  // The run itself may report a problem independent of whether the
  // backup/report stage below succeeds — a fatal error, a fail-closed
  // guard tripping on some tech-day (REMINDER_STATUS_UNKNOWN), or any other
  // path that leaves the result degraded. Checked either way (dry run or
  // --execute): silently exiting 0 here previously left an operator with no
  // signal that something needs attention (codex pre-push P2).
  const unhealthy = runIsUnhealthy(result);
  if (unhealthy) {
    console.error(`Run reported an unhealthy result (status=${result.status}${result.failed ? `, failed=${result.failed}` : ''}) — see the log above for the failed tech-day(s)' reasons.`);
  }

  // The writes (if any) have ALREADY COMMITTED by this point — everything
  // from here is reporting/backup only, and collectEntries/reportAndBackup
  // never let a failure in it look like the writes themselves were lost.
  const { entries, error: reportError } = await collectEntries(db, EXECUTE, result);
  const { backupFailed } = reportAndBackup({ execute: EXECUTE, result, entries, error: reportError, outPath: OUT_PATH });
  if (!EXECUTE) {
    console.log('\nDry run only — nothing was written. Pass --execute to commit.');
  }

  await db.destroy();
  if (unhealthy) process.exitCode = 1;
  // A --execute run's writes already committed by this point — a lost
  // backup (ledger unreadable, or the backup file itself failed to write)
  // must never exit 0 (codex pre-push P1).
  if ((reportError || backupFailed) && EXECUTE) process.exitCode = 1;
}

// require.main guard: lets route-order-cleanup.test.js require this file to
// unit-test buildDateRange/buildBackupRows/applyRollback/parseLedgerResult
// directly, without main() running against a real database as a side
// effect of the require() — `node scripts/route-order-cleanup.js`
// (require.main === module) is completely unaffected.
if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    try { await require('../server/models/db').destroy(); } catch { /* already gone */ }
    process.exit(1);
  });
}

module.exports = {
  buildDateRange, buildBackupRows, applyRollback, parseLedgerResult, recoveryInstruction, collectEntries, reportAndBackup,
  groupRowsByTechDay, readLiveTechDay, mismatchedIdsForDay, buildRollbackTargetOrder, buildRollbackPositions,
  restoredDispatchOrder, restorePositionCollisions, restoreVerdict, rollbackWindowConflict, runRollback, rollbackIsIncomplete, previewRollback, printRollbackPlan, printRollbackResult, buildRunOpts, writeBackupFile,
  outOfHorizonDates, runIsUnhealthy,
};
