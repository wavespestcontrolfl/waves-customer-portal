/**
 * Office cost per stop, review follow-up: whether the P&L figures of a snapshot month were complete.
 *
 * buildPnlReport marks its coverage incomplete when the Stripe balance ledger (refunds, disputes, card fees) has
 * not synced past the month's end, so cash revenue and net income can still move. The snapshot now stores that
 * verdict in pnl_complete (true = proven complete, false = ledger not synced past month end, NULL = rows written
 * before this column existed). A separate migration because 20261126100000 is already pushed and frozen.
 * Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('monthly_financial_snapshots', 'pnl_complete'))) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.boolean('pnl_complete').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('monthly_financial_snapshots', 'pnl_complete')) {
    await knex.schema.alterTable('monthly_financial_snapshots', (t) => {
      t.dropColumn('pnl_complete');
    });
  }
};
