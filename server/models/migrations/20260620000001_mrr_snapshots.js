/**
 * Point-in-time monthly MRR snapshots.
 *
 * The MRR Trend chart used to recompute each historical month by summing every
 * customer's CURRENT monthly_rate — i.e. "customers active back then × today's
 * price" — so a price change retroactively rewrote history. This table records
 * the ACTUAL MRR at each month (total / committed / at-risk, + by-tier), written
 * by a daily upsert cron, so the trend reads real history going forward.
 *
 * One row per month (`period_month` = the YYYY-MM-01 date). The daily cron
 * upserts the current month's row, so it stays fresh and freezes at its last
 * value when the month rolls over.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('mrr_snapshots')) return;
  await knex.schema.createTable('mrr_snapshots', (t) => {
    t.increments('id').primary();
    t.date('period_month').notNullable().unique(); // YYYY-MM-01 (ET)
    t.decimal('total_mrr', 12, 2).notNullable().defaultTo(0);
    t.decimal('committed_mrr', 12, 2).notNullable().defaultTo(0);
    t.decimal('at_risk_mrr', 12, 2).notNullable().defaultTo(0);
    t.integer('customer_count').notNullable().defaultTo(0);
    t.jsonb('by_tier');
    t.timestamp('captured_at').defaultTo(knex.fn.now()); // last upsert time
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('mrr_snapshots');
};
