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
 * those rows from a PRIOR --execute run's backup file: per tech-day under
 * the same tech-day advisory fence every route_order writer takes
 * (scheduling/tech-day-lock.js), a compare-and-swap UPDATE (route_order =
 * before WHERE route_order = after) so a row moved again since the backup
 * is reported, never silently overwritten.
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
 *   railway run node scripts/route-order-cleanup.js --rollback backup.json
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

/**
 * Rollback: restore every backed-up row's route_order under the SAME
 * tech-day advisory fence every route_order writer takes, one
 * compare-and-swap UPDATE per row (route_order = before WHERE id = ? AND
 * route_order = after) so a row that moved again since the backup is
 * reported as a mismatch, never blindly overwritten. `conn` is a knex
 * connection/transaction with `('scheduled_services')` query-builder access
 * — the caller opens the transaction so this stays a single unit of work.
 */
async function applyRollback(trx, lockTechDays, rows) {
  if (!rows.length) return { restored: 0, mismatched: [] };
  await lockTechDays(trx, rows.map((row) => ({ techId: row.technician_id, date: row.date })));
  const mismatched = [];
  let restored = 0;
  for (const row of rows) {
    const updated = await trx('scheduled_services')
      .where({ id: row.id, route_order: row.after })
      .update({ route_order: row.before });
    if (updated === 1) restored += 1;
    else mismatched.push({ id: row.id, expected_after: row.after });
  }
  return { restored, mismatched };
}

async function runRollback(db, lockTechDays, backupPath) {
  const raw = fs.readFileSync(path.resolve(backupPath), 'utf8');
  const backup = JSON.parse(raw);
  const rows = Array.isArray(backup.rows) ? backup.rows : [];
  if (!rows.length) {
    console.log('Backup file has no rows — nothing to roll back.');
    return;
  }
  console.log(`Rolling back ${rows.length} row(s) from ${backupPath} (generated_at=${backup.generated_at || 'unknown'})\n`);
  const result = await db.transaction((trx) => applyRollback(trx, lockTechDays, rows));
  console.log(`Restored ${result.restored}/${rows.length} row(s).`);
  if (result.mismatched.length) {
    console.log(`${result.mismatched.length} row(s) no longer matched the backed-up "after" value and were left alone (ids only):`);
    for (const m of result.mismatched) console.log(`  ${m.id} (expected route_order=${m.expected_after})`);
  }
}

async function main() {
  const db = require('../server/models/db');
  const { runExclusive } = require('../server/utils/cron-lock');

  if (ROLLBACK_PATH) {
    const { lockTechDays } = require('../server/services/scheduling/tech-day-lock');
    await runRollback(db, lockTechDays, ROLLBACK_PATH);
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

  if (lockResult && lockResult.skipped) {
    console.error(`Refused to run — the nightly auto-dispatch/route-reorder lock is held (${lockResult.reason}). Try again shortly.`);
    await db.destroy();
    process.exit(1);
  }

  const result = lockResult;
  let entries;
  if (EXECUTE) {
    console.log(`status=${result.status} applied=${result.applied} skipped=${result.skipped} failed=${result.failed} ledger=${result.ledgerId ?? 'none'}\n`);
    const ledgerRow = result.ledgerId
      ? await db('route_optimization_planner_runs').where({ id: result.ledgerId }).first('result')
      : null;
    entries = ledgerRow ? JSON.parse(ledgerRow.result).reorders : [];
  } else {
    console.log(`status=${result.status}\n`);
    entries = result.plan || [];
  }
  printPlan(entries);

  if (OUT_PATH) {
    const rows = buildBackupRows(entries);
    fs.writeFileSync(path.resolve(OUT_PATH), JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2));
    console.log(`\nWrote ${rows.length} row(s) to ${OUT_PATH}.`);
  }
  if (!EXECUTE) {
    console.log('\nDry run only — nothing was written. Pass --execute to commit.');
  }

  await db.destroy();
}

// require.main guard: lets route-order-cleanup.test.js require this file to
// unit-test buildDateRange/buildBackupRows/applyRollback directly, without
// main() running against a real database as a side effect of the require()
// — `node scripts/route-order-cleanup.js` (require.main === module) is
// completely unaffected.
if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    try { await require('../server/models/db').destroy(); } catch { /* already gone */ }
    process.exit(1);
  });
}

module.exports = { buildDateRange, buildBackupRows, applyRollback };
