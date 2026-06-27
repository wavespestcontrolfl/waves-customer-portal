/**
 * Per-customer point-in-time monthly rate snapshots.
 *
 * Companion to `mrr_snapshots` (which records AGGREGATE total/committed/at-risk
 * MRR per month). That aggregate can't be reversed to per-customer rates, so
 * MRR-weighted retention currently applies each customer's CURRENT monthly_rate
 * retroactively to every historical month — a later price change rewrites a
 * cohort's history.
 *
 * This table records what each qualifying customer was actually paying in each
 * month (same population as the aggregate snapshot: active, not-deleted,
 * monthly_rate > 0, internal/test excluded), written by the same daily +
 * month-end cron via recordMrrSnapshot(). It is forward-only: rows accrue from
 * the first run onward; the unknowable past is not reconstructed. Nothing reads
 * it yet — it exists to accrue exact data for true point-in-time MRR retention
 * (Phase 1).
 *
 * One row per (period_month, customer_id). The cron upserts the in-progress
 * month, so a mid-month rate change is reflected and the month freezes at its
 * last captured value (the month-end run is the truest) once it rolls over.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_mrr_snapshots')) return;
  await knex.schema.createTable('customer_mrr_snapshots', (t) => {
    t.increments('id').primary();
    t.date('period_month').notNullable(); // YYYY-MM-01 (ET)
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.decimal('monthly_rate', 10, 2).notNullable().defaultTo(0); // matches customers.monthly_rate
    t.string('waveguard_tier', 30); // tier at snapshot time, for tier-level cohort cuts later
    t.timestamp('captured_at').defaultTo(knex.fn.now()); // last upsert time for the month
    // One row per customer per month; also the index the cohort window-scan reads.
    t.unique(['period_month', 'customer_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_mrr_snapshots');
};
