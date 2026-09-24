// server/services/recurring-series-topup.js
//
// Nightly recurring-series top-up sweep.
//
// The completion-time auto-extend (routes/admin-schedule.js's
// runRecurringSeriesMaintenance / extendSeriesOnceLocked, reached via
// services/recurring-series-extend.js) only fires when a visit is
// COMPLETED and only ever adds ONE visit (upcomingCount < 2). A tech who
// leaves a visit on_site/unclosed stalls that trigger entirely, so an
// ongoing plan can run dry with nothing booked ahead (prod audit
// 2026-09-24). This sweep keeps every eligible ongoing plan booked out to
// RECURRING_TOPUP_HORIZON_DAYS by looping the SAME extend step
// (extendSeriesOnceLocked, via routes/admin-schedule.js#topUpRecurringSeries
// / #topUpRecurringSeriesLocked) instead of forking a second date-generation
// mechanism.
//
// The require of routes/admin-schedule.js is lazy (inside each function), to
// avoid a route-load cycle — same pattern and rationale as
// recurring-series-extend.js: admin-schedule.js is the module that owns the
// maintenance/extend/top-up functions, and this module is loaded by
// scheduler.js and scripts/recurring-series-topup.js, never by
// admin-schedule.js itself.
//
// GATE_RECURRING_SERIES_TOPUP (feature-gates.js#recurringSeriesTopUpLive):
// ships DARK, off unless exactly 'true'. Off, the nightly cron still runs
// this sweep in SHADOW mode (dryRun: true below) — it runs the real
// eligibility + extend-loop code path inside a transaction it rolls back, so
// nothing is written, and reports only what it would have inserted.
const logger = require('./logger');
const db = require('../models/db');

const DEFAULT_HORIZON_DAYS = 365;

// Same range as the ops script's --horizon-days flag (scripts/recurring-
// series-topup.js) — a positive integer, capped at 730 (two years; no
// legitimate recurring plan needs a longer look-ahead, and it keeps a
// fat-fingered env value from asking the sweep to walk years of candidate
// dates per series). Unlike the script (which can exit nonzero before any
// DB work on a bad --horizon-days), the cron reads this env var on every
// run and must never crash over it (Codex GitHub r4 P2) — an invalid or
// unset value falls back to DEFAULT_HORIZON_DAYS with a warning instead,
// same fail-safe posture as every other env-sourced tunable here.
function horizonDaysFromEnv() {
  const raw = process.env.RECURRING_TOPUP_HORIZON_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_HORIZON_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 730) {
    logger.warn(`[recurring-series-topup] RECURRING_TOPUP_HORIZON_DAYS="${raw}" is invalid (must be an integer from 1 to 730) — using the default of ${DEFAULT_HORIZON_DAYS} days`);
    return DEFAULT_HORIZON_DAYS;
  }
  return parsed;
}

// Root rows of every recurring series currently marked ongoing — a coarse,
// cheap pre-filter. topUpRecurringSeriesLocked makes the authoritative
// per-series eligibility call (customer active/paused/deleted/churned, and
// v1's annual-prepay exclusion — see topupSeriesSkipReason in
// admin-schedule.js), so a stale or borderline row here costs nothing
// beyond one extra no-op per-series call.
async function eligibleSeriesParentIds(conn) {
  const cols = await conn('scheduled_services').columnInfo();
  if (!cols.recurring_ongoing) return [];
  return conn('scheduled_services')
    .where({ is_recurring: true, recurring_ongoing: true })
    .whereNull('recurring_parent_id')
    .pluck('id');
}

// Run one series through the top-up loop.
//   dryRun: true  → the real code path (topUpRecurringSeriesWithLocks: the
//                    same maintenance lock + comms fence, then the loop) inside
//                    a transaction this function opens and always rolls back.
//                    No commit, no reminders — used by the gate-off shadow
//                    pass and the ops script's default (no --apply) mode.
//   dryRun: false → topUpRecurringSeries (the writing wrapper): commits and
//                    registers a reminder for each spawned visit, exactly as
//                    the completion-path wrapper does for its own extend.
// A prior version of this fix (Codex GitHub r3 P2) tried nesting every
// series' dry run inside ONE outer transaction (trx.transaction()
// savepoints) so a later series could see an earlier one's simulated
// inserts. Reverted: topUpRecurringSeriesWithLocks takes its maintenance
// and customer-comms fences via pg_advisory_xact_lock, which Postgres
// scopes to the ENCLOSING REAL transaction, not a savepoint — releasing a
// savepoint does not release the locks taken inside it. Sharing one outer
// transaction across every series in the sweep therefore held EVERY
// series' advisory locks for the WHOLE sweep, not just its own series, so
// a same-customer series processed earlier in the sweep could still hold
// that customer's comms lock while this function waited on a DIFFERENT
// series' maintenance lock for the same customer — exactly the
// lock-order cycle a concurrent live completion (which takes maintenance
// lock then comms lock, in that order) could deadlock against, live
// maintenance included, even with the top-up gate off (caught by this
// repo's local pre-push Codex audit). Each series keeps its own
// independent, independently-rolled-back transaction instead — the
// cross-series "sees earlier simulated inserts" accuracy improvement is
// not implemented; a dry-run preview across two series for the same
// customer can therefore differ slightly from what an --apply run (which
// commits each series before the next starts) would actually do.
//
// A later version of the SAME revert briefly kept an optional `conn` for
// a caller that already had its own transaction. Removed (Codex GitHub r4
// P2): nothing in this codebase ever called it that way (the sweep and
// the ops script both call this with no conn at all), and the apply
// branch specifically would have self-deadlocked — registering a
// reminder through a fresh connection with a foreign key to a
// scheduled_services row this function's own caller's transaction had
// inserted but not yet committed, while that caller was itself
// synchronously waiting on this call to return before it could commit.
// topUpRecurringSeries (admin-schedule.js) now also refuses to run inside
// a caller-supplied open transaction at all, as defense in depth, but the
// simplest fix is not exposing the capability here in the first place.
async function topUpOneSeries(parentId, { horizonDays, dryRun }) {
  const { topUpRecurringSeries, topUpRecurringSeriesWithLocks } = require('../routes/admin-schedule');
  if (!dryRun) {
    return topUpRecurringSeries(db, parentId, { horizonDays });
  }
  const trx = await db.transaction();
  // Knex's default doNotRejectOnRollback RESOLVES trx.executionPromise on a
  // bare rollback() with no error — but annual-prepay-renewals.js's
  // fileCoverageExceptionAfterCommit (reached from applyExtensionPrepayCoverage
  // inside the extend step) gates its admin notification on that SAME
  // promise rejecting, to skip firing when its caller rolls back. Left
  // alone, a dry run's rollback would read as "committed" to that gate and
  // could ring a real notification bell for coverage math that never
  // actually wrote anything (Codex pre-push P1). Passing an explicit error
  // to rollback() forces the reject; the no-op catch here is only to keep
  // that rejection from surfacing as an unhandled-rejection warning for
  // whichever caller (if any) reads executionPromise on this trx.
  if (trx.executionPromise && typeof trx.executionPromise.catch === 'function') {
    trx.executionPromise.catch(() => {});
  }
  try {
    return await topUpRecurringSeriesWithLocks(trx, parentId, { horizonDays });
  } finally {
    await trx.rollback(new Error('recurring-series-topup: intentional dry-run rollback')).catch(() => {});
  }
}

// The sweep: scans eligible parents and tops each one up, isolating
// failures per series (one bad series must never stop the run). Returns a
// summary the cron/script log; `skipped` tallies by reason so a bulk cause
// (e.g. everyone paused, or a term-cap lookup outage) is visible at a
// glance instead of buried in per-series lines.
async function runRecurringSeriesTopUpSweep({ horizonDays = horizonDaysFromEnv(), dryRun = false, parentIds = null } = {}) {
  const ids = parentIds || await eligibleSeriesParentIds(db);
  const summary = {
    dryRun, horizonDays, scanned: ids.length, toppedUp: 0, visitsInserted: 0,
    skipped: {}, errors: [], series: [],
  };
  for (const parentId of ids) {
    try {
      // Sequential, not parallel: each series opens and settles its OWN
      // transaction (topUpOneSeries) before the next starts, so two
      // series can't race each other's locks or writes.
      const result = await topUpOneSeries(parentId, { horizonDays, dryRun });
      const inserted = result?.spawnedVisits?.length || 0;
      if (result?.skipped) {
        summary.skipped[result.skipped] = (summary.skipped[result.skipped] || 0) + 1;
      } else if (inserted > 0) {
        summary.toppedUp += 1;
        summary.visitsInserted += inserted;
      }
      summary.series.push({
        parentId,
        skipped: result?.skipped || null,
        insertedDates: (result?.spawnedVisits || []).map((v) => v.scheduledDate),
      });
    } catch (e) {
      summary.errors.push({ parentId, error: e.message });
      logger.error(`[recurring-series-topup] series ${parentId} failed: ${e.message}`);
    }
  }
  logger.info(
    `[recurring-series-topup] ${dryRun ? 'shadow' : 'apply'} run: scanned=${summary.scanned} `
    + `toppedUp=${summary.toppedUp} visitsInserted=${summary.visitsInserted} `
    + `skipped=${JSON.stringify(summary.skipped)} errors=${summary.errors.length}`,
  );
  return summary;
}

module.exports = {
  DEFAULT_HORIZON_DAYS,
  horizonDaysFromEnv,
  eligibleSeriesParentIds,
  topUpOneSeries,
  runRecurringSeriesTopUpSweep,
};
