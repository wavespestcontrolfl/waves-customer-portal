/**
 * Global balance-transaction sync support. Stripe refuses per-payout
 * balance-transaction listing for MANUAL payouts ("Balance transaction
 * history can only be filtered on automatic transfers, not manual") — and
 * every payout on this account is manual, so the per-payout transaction
 * sync could never populate the ledger. The replacement syncs the balance
 * transaction stream globally and upserts by stripe_txn_id, which therefore
 * needs a unique index (partial — legacy NULLs stay legal; the table was
 * empty in prod when this shipped).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS stripe_payout_transactions_txn_id_uniq
    ON stripe_payout_transactions (stripe_txn_id)
    WHERE stripe_txn_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  await knex.raw('DROP INDEX IF EXISTS stripe_payout_transactions_txn_id_uniq');
};
