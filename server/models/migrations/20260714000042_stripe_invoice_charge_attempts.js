/**
 * Durable claim for admin/field saved-card invoice charges.
 *
 * The claim commits before Stripe is called. The partial unique index is the
 * cross-process serialization boundary: while a charge is in flight or has an
 * ambiguous outcome, no second request can claim the same invoice. This stays
 * true across request timeouts, process crashes, page reloads, and a failure to
 * write the ordinary payments ledger.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('stripe_invoice_charge_attempts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('invoice_id').notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.uuid('payment_method_id').references('id').inTable('payment_methods').onDelete('SET NULL');
    // Immutable Stripe identity used by webhook reconciliation even if the
    // mutable local payment_methods row is later deleted.
    t.string('stripe_payment_method_id', 100).notNullable();
    t.string('idempotency_key', 180).notNullable().unique();
    t.string('status', 24).notNullable().defaultTo('claimed');
    t.string('stripe_payment_intent_id');
    t.decimal('amount', 12, 2);
    t.decimal('credit_applied_delta', 12, 2).notNullable().defaultTo(0);
    t.decimal('credit_applied_total', 12, 2).notNullable().defaultTo(0);
    t.text('error_message');
    t.timestamp('resolved_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['invoice_id', 'status']);
    t.index(['stripe_payment_intent_id']);
  });

  await knex.raw(`
    ALTER TABLE stripe_invoice_charge_attempts
    ADD CONSTRAINT stripe_invoice_charge_attempts_status_check
    CHECK (status IN ('claimed', 'succeeded', 'failed', 'ambiguous'))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX stripe_invoice_charge_attempts_one_blocking_per_invoice
    ON stripe_invoice_charge_attempts (invoice_id)
    WHERE resolved_at IS NULL AND status IN ('claimed', 'ambiguous')
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stripe_invoice_charge_attempts');
};
