/**
 * Backfill service_records financial columns from job costing.
 *
 * The Dashboard (admin-dashboard core-kpis: Gross Margin, Stops/Hour, Tech
 * Utilization, Revenue/Man-Hour) and /admin/revenue read
 * service_records.revenue/labor_hours/gross_margin_pct/revenue_per_man_hour and
 * filter `whereNotNull('revenue')`. Completion only ever wrote those to the
 * separate job_costs table, so every financial tile rendered "—" for the entire
 * history. job-costing now writes the financials through to service_records on
 * completion; this migration recomputes the same fields for the existing
 * completed history so the tiles light up immediately on deploy (rather than
 * only for visits completed after the deploy).
 *
 * Runs on the migration's own knex handle (job-costing threads it through every
 * query), so no app db singleton/pool is opened during migrate. Idempotent and
 * safe to re-run. No-op when the 20260401000027 financial columns are absent.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasColumn('service_records', 'revenue'))) return;

  const { backfillServiceRecordFinancials } = require('../../services/job-costing');
  await backfillServiceRecordFinancials(knex);
};

exports.down = async function down() {
  // No-op: recomputed financials are derived data and safe to keep. Clearing
  // them would only re-blank the dashboard tiles.
};
