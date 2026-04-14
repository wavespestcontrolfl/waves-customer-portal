/**
 * Migration — Banking & Cash Flow
 *
 * Tables:
 * - stripe_payouts: Synced payout records from Stripe
 * - stripe_payout_transactions: Individual balance transactions within each payout
 * - bank_reconciliation: Bank-side reconciliation against Stripe payouts
 * - stripe_sync_state: Cursor tracking for incremental Stripe syncs
 */
exports.up = async function (knex) {

  // ── Stripe Payouts ─────────────────────────────────────────────
  if (!(await knex.schema.hasTable('stripe_payouts'))) {
    await knex.schema.createTable('stripe_payouts', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('stripe_payout_id').unique();
      t.decimal('amount', 12, 2);
      t.text('currency').defaultTo('usd');
      t.text('status');
      t.timestamp('arrival_date', { useTz: true });
      t.timestamp('created_at_stripe', { useTz: true });
      t.text('method');
      t.text('type');
      t.text('description');
      t.text('failure_message');
      t.text('bank_name');
      t.text('bank_last_four');
      t.integer('transaction_count').defaultTo(0);
      t.decimal('fee_total', 10, 2).defaultTo(0);
      t.boolean('reconciled').defaultTo(false);
      t.timestamp('reconciled_at', { useTz: true });
      t.text('reconciled_by');
      t.jsonb('metadata');
      t.timestamp('synced_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.index('status');
      t.index('arrival_date');
      t.index('reconciled');
    });
  }

  // ── Stripe Payout Transactions ─────────────────────────────────
  if (!(await knex.schema.hasTable('stripe_payout_transactions'))) {
    await knex.schema.createTable('stripe_payout_transactions', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('payout_id').references('id').inTable('stripe_payouts').onDelete('CASCADE');
      t.text('stripe_txn_id');
      t.text('type');
      t.decimal('amount', 10, 2);
      t.decimal('fee', 10, 2).defaultTo(0);
      t.decimal('net', 10, 2);
      t.text('description');
      t.text('customer_name');
      t.uuid('customer_id');
      t.uuid('invoice_id');
      t.uuid('payment_id');
      t.timestamp('available_on', { useTz: true });
      t.timestamp('created_at_stripe', { useTz: true });
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.index('payout_id');
      t.index('stripe_txn_id');
      t.index('customer_id');
    });
  }

  // ── Bank Reconciliation ────────────────────────────────────────
  if (!(await knex.schema.hasTable('bank_reconciliation'))) {
    await knex.schema.createTable('bank_reconciliation', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('payout_id').references('id').inTable('stripe_payouts');
      t.decimal('expected_amount', 12, 2);
      t.decimal('actual_amount', 12, 2);
      t.boolean('matched').defaultTo(false);
      t.decimal('discrepancy', 10, 2);
      t.text('notes');
      t.timestamp('reconciled_at', { useTz: true });
      t.text('reconciled_by');
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.index('payout_id');
      t.index('matched');
    });
  }

  // ── Stripe Sync State ──────────────────────────────────────────
  if (!(await knex.schema.hasTable('stripe_sync_state'))) {
    await knex.schema.createTable('stripe_sync_state', t => {
      t.increments('id');
      t.text('sync_type').unique();
      t.timestamp('last_sync_at', { useTz: true });
      t.text('last_payout_id');
      t.text('cursor');
      t.jsonb('metadata');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('stripe_sync_state');
  await knex.schema.dropTableIfExists('bank_reconciliation');
  await knex.schema.dropTableIfExists('stripe_payout_transactions');
  await knex.schema.dropTableIfExists('stripe_payouts');
};
