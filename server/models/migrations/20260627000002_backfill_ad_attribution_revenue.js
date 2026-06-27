/**
 * Backfill realized revenue / gross profit / projected LTV onto existing
 * ad_service_attribution funnel rows.
 *
 * Going forward, job-costing's calculateJobCost keeps each customer's funnel row
 * in sync on completion. This one-time pass populates the columns for customers
 * whose visits were already completed before the bridge existed (otherwise the
 * /admin/ads ROI views only fill in for customers serviced after deploy).
 *
 * Idempotent and re-runnable: syncCustomerAdAttribution re-sums from
 * service_records truth, so re-running converges to the same values. down() is a
 * no-op — this is a data backfill, not a schema change.
 */

const { backfillAdAttributionFromServiceRecords } = require('../../services/ad-attribution-sync');

exports.up = async function up(knex) {
  // No-op if the attribution table/columns aren't present in this environment.
  if (!(await knex.schema.hasTable('ad_service_attribution'))) return;
  await backfillAdAttributionFromServiceRecords(knex);
};

exports.down = async function down() {
  // Data backfill only; nothing to reverse.
};
