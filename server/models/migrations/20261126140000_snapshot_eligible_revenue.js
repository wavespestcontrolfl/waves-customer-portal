/**
 * Buyer view (owner approved 2026-11-26): monthly_financial_snapshots.eligible_job_revenue numeric(12,2) NULL, the month's
 * completed-visit revenue (service_records.revenue, visits with a revenue figure) of every customer except the internal test
 * accounts: the same population recurring_revenue is taken from. The recurring share is recurring_revenue over this, both
 * written in the same snapshot transaction, so the two sides can never come from different moments. (completed_job_revenue
 * includes the test accounts, so it is not that denominator.) NULL = a row stored before this column existed.
 * Its own file because 20261126120000 and 20261126130000 are already pushed. Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('monthly_financial_snapshots', 'eligible_job_revenue'))) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.decimal('eligible_job_revenue', 12, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('monthly_financial_snapshots', 'eligible_job_revenue')) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.dropColumn('eligible_job_revenue');
    });
  }
};
