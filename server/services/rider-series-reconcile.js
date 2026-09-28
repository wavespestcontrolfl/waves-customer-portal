/**
 * Nightly rider-series reconcile sweep (pest-rides-the-lawn-rhythm PR 1).
 *
 * The in-band hooks (host seeding/auto-extend/top-up sync their riders
 * immediately, a rider's own completion/top-up/plan-ending-alert resyncs
 * itself — see rider-series.js and its call sites in
 * recurring-appointment-seeder.js and routes/admin-schedule.js) cover the
 * common paths. This sweep is the safety net for everything else: a path
 * left un-hooked (an admin cadence/day edit), a sync that lost a
 * non-blocking lock race and was skipped for that pass, or a rider whose
 * link was set directly (PR 2/3's accept path and backfill script). It
 * simply calls syncRiderSeries for every parent that currently has
 * rides_parent_id set — a no-op scan while nothing sets that column.
 *
 * Registered in scheduler.js under GATE_CRON_JOBS, same convention as
 * every other nightly maintenance sweep (see recurring-series-topup.js).
 * Per-rider errors are logged and never stop the loop.
 */
const logger = require('./logger');
const db = require('../models/db');

async function eligibleRiderParentIds(conn) {
  const cols = await conn('scheduled_services').columnInfo();
  if (!cols.rides_parent_id) return [];
  return conn('scheduled_services')
    .whereNotNull('rides_parent_id')
    .pluck('id');
}

async function runRiderSeriesReconcileSweep({ parentIds = null } = {}) {
  const { syncRiderSeries } = require('./rider-series');
  const ids = parentIds || await eligibleRiderParentIds(db);
  const summary = { scanned: ids.length, synced: 0, skipped: {}, errors: [] };
  for (const parentId of ids) {
    try {
      const result = await syncRiderSeries(db, parentId, { source: 'nightly_reconcile' });
      if (result.skipped === 'error') {
        // syncRiderSeries itself already caught and logged the real error
        // (it never lets one rider's exception escape the sweep) — that
        // per-rider failure must count toward job health (P2 fix #8), not
        // vanish into summary.skipped alongside benign, expected skips
        // (lock contention, an ineligible customer, ...). A run where
        // every rider errored otherwise reads as a healthy "skipped: N",
        // never surfacing to whatever watches this summary.
        summary.errors.push({ parentId, error: 'sync failed (see server logs for the underlying error)' });
      } else if (result.skipped) {
        summary.skipped[result.skipped] = (summary.skipped[result.skipped] || 0) + 1;
      } else {
        summary.synced += 1;
      }
    } catch (e) {
      summary.errors.push({ parentId, error: e.message });
      logger.error(`[rider-series-reconcile] parent ${parentId} failed: ${e.message}`);
    }
  }
  logger.info(
    `[rider-series-reconcile] scanned=${summary.scanned} synced=${summary.synced} `
    + `skipped=${JSON.stringify(summary.skipped)} errors=${summary.errors.length}`,
  );
  return summary;
}

module.exports = { runRiderSeriesReconcileSweep, eligibleRiderParentIds };
