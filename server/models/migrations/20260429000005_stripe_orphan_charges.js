/**
 * Stripe orphan-charges table.
 *
 * Records the rare case where Stripe accepts a charge (HTTP 200,
 * paymentIntent.status === 'succeeded') but our subsequent INSERT INTO
 * payments fails — schema mismatch, NOT NULL violation, transient DB
 * connection blip mid-transaction, etc. The customer was billed; we
 * just couldn't write the payments-table ledger row.
 *
 * Without this table:
 *   - StripeService.charge() returned a synthetic record with `_db_error`
 *     and was treated by callers as a success
 *   - The autopay cron's existing catch block would otherwise schedule a
 *     RETRY for the same charge, double-billing the customer
 *   - There was no queryable list of "Stripe collected money we never
 *     accounted for" — operators had to scan logs
 *
 * With this table:
 *   - charge() inserts here when the payments-table write fails
 *   - charge() throws Error.code = 'STRIPE_CHARGED_DB_FAILED' so the
 *     cron's catch block can branch (skip retry, send a different SMS,
 *     create a critical health alert)
 *   - Admin can SELECT * FROM stripe_orphan_charges WHERE resolved = false
 *     to drive a reconciliation queue
 *
 * Resolved rows stay around for audit; nothing prunes this table.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('stripe_orphan_charges', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('stripe_payment_intent_id').notNullable().unique();
    t.string('stripe_charge_id');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('invoice_id').references('id').inTable('invoices').onDelete('SET NULL');
    t.decimal('amount', 12, 2).notNullable();
    t.string('source', 64);  // 'autopay_charge' | 'invoice_card_on_file' | etc.
    t.text('original_db_error').notNullable();
    t.boolean('resolved').notNullable().defaultTo(false);
    t.timestamp('resolved_at');
    t.uuid('resolved_by').references('id').inTable('technicians').onDelete('SET NULL');
    t.text('resolution_notes');
    t.timestamps(true, true);
    t.index(['resolved']);
    t.index(['customer_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('stripe_orphan_charges');
};
