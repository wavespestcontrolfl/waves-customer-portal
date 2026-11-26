/**
 * Buyer view (owner approved 2026-11-26): monthly_financial_snapshots.job_gross_profit numeric(12,2) NULL, the dollars behind
 * gross_margin_pct: SUM(service_records.gross_profit) over the month's visits with a revenue figure (the dashboard gross-margin
 * tile's own sum, from job-costing), kept in a month whose revenue is zero (a callback-only month is a loss, not a gap). A
 * period's per-job margin is total job profit over total completed_job_revenue, so no month's weight is lost to a missing percent.
 * NULL = a row stored before this column existed. Its own file because 20261126120000, 130000 and 140000 are already pushed.
 * Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('monthly_financial_snapshots', 'job_gross_profit'))) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.decimal('job_gross_profit', 12, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('monthly_financial_snapshots', 'job_gross_profit')) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.dropColumn('job_gross_profit');
    });
  }
};
