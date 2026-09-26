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
 * transaction; --rollback <path> --execute performs it. All-or-nothing
 * PER TECH-DAY under the same tech-day advisory fence every route_order
 * writer takes (scheduling/tech-day-lock.js): every backed-up row for a
 * (technician_id, date) is re-read FOR UPDATE first, and only if EVERY one
 * of them still matches the backup's "after" (route_order, date AND
 * technician_id — a row moved to a different tech-day since the backup is
 * a mismatch too, never silently overwritten) does the whole day's
 * compare-and-swap UPDATEs commit, in one savepoint; any mismatch, or a
 * CAS somehow affecting 0 rows, skips/rolls back that WHOLE day (reported
 * with the mismatching ids) — never a partial day.
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

/** `YYYY-MM-DD` for either a Date (pg's typical date-column shape) or a
 *  string — self-contained rather than importing a date util, since the
 *  comparison here is a plain string slice, not ET wall-clock logic. */
function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
}

/** Backup rows grouped into one entry per (technician_id, date) — the unit
 *  the all-or-nothing rollback (and its dry-run preview) both operate on. */
function groupRowsByTechDay(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.technician_id}:${row.date}`;
    if (!byKey.has(key)) byKey.set(key, { technician_id: row.technician_id, date: row.date, rows: [] });
    byKey.get(key).rows.push(row);
  }
  return [...byKey.values()];
}

/** Re-reads the CURRENT state of one tech-day's backed-up rows and returns
 *  the ids that no longer match the backup's "after" — id missing entirely,
 *  or its route_order/date/technician_id isn't EXACTLY what the backup
 *  recorded (a row reassigned to a different tech-day since the backup can
 *  carry the SAME numeric route_order there by coincidence — id +
 *  route_order alone would silently overwrite a position that belongs to a
 *  different day's sequence, codex pre-push P1). `forUpdate: true` locks
 *  the rows (the real rollback, inside its transaction); the dry-run
 *  preview reads unlocked, since it opens no transaction at all. */
async function mismatchedIdsForDay(conn, dayRows) {
  const ids = dayRows.map((row) => row.id);
  const live = await conn('scheduled_services').whereIn('id', ids)
    .select('id', 'route_order', 'scheduled_date', 'technician_id');
  const liveById = new Map(live.map((row) => [row.id, row]));
  return dayRows.filter((row) => {
    const liveRow = liveById.get(row.id);
    return !liveRow
      || Number(liveRow.route_order) !== Number(row.after)
      || dateOnly(liveRow.scheduled_date) !== row.date
      || String(liveRow.technician_id) !== String(row.technician_id);
  }).map((row) => row.id);
}

/**
 * Read-only preview for `--rollback <file>` WITHOUT --execute: the exact
 * same per-tech-day mismatch check the real rollback runs, but with no
 * lock and no transaction — nothing here can ever write. One plan entry
 * per tech-day: `would_restore` (every row still matches) or the list of
 * `mismatched_ids` that would skip the whole day.
 */
async function previewRollback(conn, rows) {
  const days = groupRowsByTechDay(rows);
  const plan = [];
  for (const day of days) {
    const mismatchedIds = await mismatchedIdsForDay(conn, day.rows);
    plan.push({
      technician_id: day.technician_id, date: day.date, row_count: day.rows.length,
      would_restore: mismatchedIds.length === 0, mismatched_ids: mismatchedIds,
    });
  }
  return plan;
}

/**
 * Rollback: restore every backed-up row's route_order under the SAME
 * tech-day advisory fence every route_order writer takes — ALL-OR-NOTHING
 * per (technician_id, date): every row for that tech-day is re-read FOR
 * UPDATE first (mismatchedIdsForDay), and only when every one of them
 * still matches does the whole day's compare-and-swap UPDATEs run, inside
 * a SAVEPOINT (a nested knex transaction) so a same-transaction anomaly —
 * a CAS somehow affecting 0 rows despite the FOR UPDATE check just having
 * passed — rolls back only that day's writes, not the other tech-days'.
 * `trx` is the outer transaction the caller opened; this stays a single
 * unit of work at the OUTER level (every day's savepoint is nested inside
 * it), so a fatal error before the caller commits still discards
 * everything.
 */
async function applyRollback(trx, lockTechDays, rows) {
  if (!rows.length) return { restored: 0, mismatched: [], skippedDays: [] };
  const days = groupRowsByTechDay(rows);
  await lockTechDays(trx, days.map((day) => ({ techId: day.technician_id, date: day.date })));
  let restored = 0;
  const skippedDays = [];
  for (const day of days) {
    const mismatchedIds = await mismatchedIdsForDay(trx, day.rows);
    if (mismatchedIds.length) {
      skippedDays.push({ technician_id: day.technician_id, date: day.date, mismatched_ids: mismatchedIds });
      continue;
    }
    try {
      restored += await trx.transaction(async (sp) => {
        let count = 0;
        for (const row of day.rows) {
          const updated = await sp('scheduled_services')
            .where({ id: row.id, route_order: row.after, scheduled_date: row.date, technician_id: row.technician_id })
            .update({ route_order: row.before });
          if (updated !== 1) throw new Error(`CAS affected ${updated} row(s) for ${row.id} — rolling back the whole tech-day`);
          count += 1;
        }
        return count;
      });
    } catch {
      // The savepoint already rolled back every write this day attempted —
      // report the whole day as mismatched (ids only), matching the
      // all-or-nothing contract exactly as the FOR UPDATE check would have.
      skippedDays.push({ technician_id: day.technician_id, date: day.date, mismatched_ids: day.rows.map((row) => row.id) });
    }
  }
  return { restored, mismatched: skippedDays.flatMap((day) => day.mismatched_ids), skippedDays };
}

/** One line per tech-day for the dry-run --rollback preview, ids only. */
function printRollbackPlan(plan) {
  for (const day of plan) {
    if (day.would_restore) {
      console.log(`${day.date} tech ${day.technician_id}: would restore ${day.row_count} row(s)`);
    } else {
      console.log(`${day.date} tech ${day.technician_id}: WOULD SKIP (${day.mismatched_ids.length} row(s) no longer match, ids only): ${day.mismatched_ids.join(', ')}`);
    }
  }
}

/** One line per tech-day for the real --rollback --execute outcome, ids only. */
function printRollbackResult(result, totalRows) {
  console.log(`Restored ${result.restored}/${totalRows} row(s).`);
  if (result.skippedDays.length) {
    console.log(`${result.skippedDays.length} tech-day(s) skipped whole (all-or-nothing) — a row no longer matched the backup:`);
    for (const day of result.skippedDays) {
      console.log(`  ${day.date} tech ${day.technician_id}: ${day.mismatched_ids.join(', ')}`);
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
 *  actually wrong, not a normal race) and, when it agrees, supplies the
 *  richer per-day reasons/source detail the printed plan shows. A ledger
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
  // Primary wins whenever it has anything; the ledger is used only when
  // primary is empty (an older/unexpected result shape) and the ledger
  // still has real evidence.
  const entries = primary.length > 0 ? primary : ledgerEntries;
  if ((result.applied || 0) > 0 && !entries.some(hasChanges)) {
    return {
      entries: [],
      error: new Error(`runRouteReorder reported ${result.applied} applied tech-day(s) but neither its own result nor the ledger carried any route_order_changes`),
    };
  }
  return { entries, error: null };
}

/** Prints the plan and (with --out) writes the backup file — or, on any
 *  failure at this stage, prints recoveryInstruction instead of leaving the
 *  operator to guess whether an --execute run's writes are backed up.
 *  Never writes an empty/partial backup file after a read failure — that
 *  would look like a clean "nothing changed" file instead of a missing one. */
function reportAndBackup({ execute, result, entries, error, outPath }) {
  if (error) {
    console.error(`Could not read back the ledger row for reporting/backup (${error.message}).`);
    console.error(recoveryInstruction(result.ledgerId));
  } else {
    printPlan(entries);
  }
  if (!outPath) return;
  if (error) {
    console.error(`Refusing to write ${outPath} — the ledger could not be read back (see above). ${recoveryInstruction(result.ledgerId)}`);
    return;
  }
  try {
    const rows = buildBackupRows(entries);
    fs.writeFileSync(path.resolve(outPath), JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
    console.log(`\nWrote ${rows.length} row(s) to ${outPath}.`);
  } catch (err) {
    console.error(`Failed to write backup file ${outPath}: ${err.message}`);
    if (execute) console.error(recoveryInstruction(result.ledgerId));
  }
}

async function runRollback(db, lockTechDays, backupPath, execute) {
  const raw = fs.readFileSync(path.resolve(backupPath), 'utf8');
  const backup = JSON.parse(raw);
  const rows = Array.isArray(backup.rows) ? backup.rows : [];
  if (!rows.length) {
    console.log('Backup file has no rows — nothing to roll back.');
    return;
  }
  if (!execute) {
    // Dry run by default, same convention as the rest of the script — no
    // lock, no transaction, nothing here can write.
    console.log(`DRY RUN — would roll back ${rows.length} row(s) from ${backupPath} (generated_at=${backup.generated_at || 'unknown'})\n`);
    printRollbackPlan(await previewRollback(db, rows));
    console.log('\nDry run only — nothing was written. Pass --rollback <file> --execute to commit.');
    return;
  }
  console.log(`EXECUTING — rolling back ${rows.length} row(s) from ${backupPath} (generated_at=${backup.generated_at || 'unknown'})\n`);
  const result = await db.transaction((trx) => applyRollback(trx, lockTechDays, rows));
  printRollbackResult(result, rows.length);
}

async function main() {
  const db = require('../server/models/db');
  const { runExclusive, wasLockSkipped } = require('../server/utils/cron-lock');

  if (ROLLBACK_PATH) {
    const { lockTechDays } = require('../server/services/scheduling/tech-day-lock');
    await runRollback(db, lockTechDays, ROLLBACK_PATH, EXECUTE);
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

  console.log(`${EXECUTE ? 'EXECUTING' : 'DRY RUN'} — route-order cleanup ${from}..${to} (${range.dates.length} day${range.dates.length === 1 ? '' : 's'})\n`);

  const { runRouteReorder } = require('../server/services/route-reorder');
  const lockResult = await runExclusive('auto-dispatch-recurring', () => runRouteReorder({
    canonicalizeStale: true, dates: range.dates, dryRun: !EXECUTE, runType: 'route_order_cleanup', now,
  }), { recordHealth: false, waitForSlot: false });

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

  // The writes (if any) have ALREADY COMMITTED by this point — everything
  // from here is reporting/backup only, and collectEntries/reportAndBackup
  // never let a failure in it look like the writes themselves were lost.
  const { entries, error: reportError } = await collectEntries(db, EXECUTE, result);
  reportAndBackup({ execute: EXECUTE, result, entries, error: reportError, outPath: OUT_PATH });
  if (!EXECUTE) {
    console.log('\nDry run only — nothing was written. Pass --execute to commit.');
  }

  await db.destroy();
  if (reportError && EXECUTE) process.exitCode = 1;
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
  groupRowsByTechDay, mismatchedIdsForDay, previewRollback, printRollbackPlan, printRollbackResult,
};
