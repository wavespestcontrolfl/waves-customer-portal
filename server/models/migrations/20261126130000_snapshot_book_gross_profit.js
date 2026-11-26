/**
 * Buyer view (owner approved 2026-11-26): monthly_financial_snapshots.book_gross_profit numeric(12,2) NULL, the dollars
 * behind book_gross_margin_pct (P&L gross profit less the owner field allowance). It is stored even in a month with no or
 * negative revenue, so a period's book margin is total profit over total revenue and never drops a loss month.
 * Its own file because 20261126120000 was already pushed (knex tracks migrations by filename). Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('monthly_financial_snapshots', 'book_gross_profit'))) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.decimal('book_gross_profit', 12, 2).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('monthly_financial_snapshots', 'book_gross_profit')) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.dropColumn('book_gross_profit');
    });
  }
};
