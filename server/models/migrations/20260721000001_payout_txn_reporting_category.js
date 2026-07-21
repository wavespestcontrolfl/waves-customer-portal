/**
 * stripe_payout_transactions.reporting_category — Stripe's canonical
 * balance-transaction classification (charge / refund / refund_failure /
 * dispute / dispute_reversal / fee / ...). Needed because `type` alone is
 * ambiguous for disputes: Stripe carries dispute money movements as type
 * 'adjustment', an umbrella type that also covers unrelated balance
 * activity — the P&L's dispute netting must filter on reporting_category,
 * never on type='adjustment'. Populated by syncPayoutTransactions on every
 * (re)sync; the sync does a full delete+insert per payout, so historical
 * rows self-heal on the next sync (prod had zero synced rows at ship time).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  if (await knex.schema.hasColumn('stripe_payout_transactions', 'reporting_category')) return;
  await knex.schema.alterTable('stripe_payout_transactions', (t) => {
    t.string('reporting_category', 64).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  if (!(await knex.schema.hasColumn('stripe_payout_transactions', 'reporting_category'))) return;
  await knex.schema.alterTable('stripe_payout_transactions', (t) => {
    t.dropColumn('reporting_category');
  });
};
