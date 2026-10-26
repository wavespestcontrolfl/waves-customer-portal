/**
 * Re-cost completed visits since 2026-04-01 after two job-costing fixes, so
 * the Dashboard's Gross Margin and Tech Utilization (and every other reader of
 * service_records.material_cost / labor_hours) stop carrying the old errors:
 *
 *   1. The property_application_history fallback multiplied the amount applied
 *      by a PACKAGE price (31.5 fl oz × a $38.05 2.5-gal jug = $1,198.57); it
 *      now prices the amount like the inventory deduction (inventory-cost.js).
 *   2. A completed visit with no measured time on site booked 0 labor hours;
 *      it now books its scheduled estimate (estimated_duration_minutes).
 *
 * Revenue is kept exactly as written, $0 included (keepRecordedRevenue). No
 * transaction wraps the whole run: each visit's costing commits on its own, so
 * no row lock is held across hundreds of visits during the deploy. One visit's
 * failure is logged and skipped, never thrown (this runs as the pre-deploy
 * command, where a throw rejects the deploy). Idempotent and safe to re-run.
 */

exports.config = { transaction: false };

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasColumn('service_records', 'revenue'))) return;
  if (!(await knex.schema.hasTable('job_costs'))) return;

  const { backfillServiceRecordFinancials } = require('../../services/job-costing');
  await backfillServiceRecordFinancials(knex, { since: '2026-04-01', keepRecordedRevenue: true });
};

exports.down = async function down() {
  // No-op: re-costed financials are derived data; the old values were wrong.
};
