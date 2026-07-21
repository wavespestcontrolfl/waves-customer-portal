/**
 * Global balance-transaction sync support. Stripe refuses per-payout
 * balance-transaction listing for MANUAL payouts ("Balance transaction
 * history can only be filtered on automatic transfers, not manual") — and
 * every payout on this account is manual, so the per-payout transaction
 * sync could never populate the ledger. The replacement syncs the balance
 * transaction stream globally and upserts by stripe_txn_id, which therefore
 * needs a FULL (non-partial) unique index: PostgreSQL cannot infer a
 * partial index from a plain ON CONFLICT (col) target, so a partial one
 * would make every upsert fail with "no matching constraint". NULLs remain
 * legal — Postgres treats them as distinct in unique indexes. (The table
 * was empty in prod when this shipped.)
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS stripe_payout_transactions_txn_id_uniq
    ON stripe_payout_transactions (stripe_txn_id)
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) return;
  await knex.raw('DROP INDEX IF EXISTS stripe_payout_transactions_txn_id_uniq');
};
