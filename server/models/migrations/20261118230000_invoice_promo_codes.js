/**
 * Promo code a customer typed on an invoice's pay page (owner-approved
 * 2026-11-18, GATE_PAY_PROMO_CODE).
 *
 * The code is recorded when it is entered and no money moves then. The
 * payment-setup step that follows (stripe.js createInvoicePaymentIntent, the
 * seam that already re-prices an open payment when account credit applies)
 * posts the credit to the customer-credit ledger once and applies it to this
 * invoice (services/invoice-promo-code.js).
 *
 * Exactly-once, enforced by the schema (the estimate_promo_codes discipline):
 *   - ONE code per invoice, ever (unique invoice_id)
 *   - ONE mint per row, ever (unique credit_ledger_id)
 *   - ONE redemption of a code per customer here (partial unique index); the
 *     same check across estimates and invoices is made under the discount
 *     row lock.
 *
 * `credit_amount` is FROZEN at entry from the discount row.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('invoice_promo_codes')) return;

  await knex.schema.createTable('invoice_promo_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('invoice_id').notNullable().unique()
      .references('id').inTable('invoices').onDelete('CASCADE');
    t.uuid('discount_id').notNullable()
      .references('id').inTable('discounts').onDelete('CASCADE');
    t.uuid('customer_id')
      .references('id').inTable('customers').onDelete('SET NULL');
    t.string('code', 50).notNullable();
    t.decimal('credit_amount', 10, 2).notNullable();
    // entered → redeemed | void. Terminal states never regress.
    t.string('status', 24).notNullable().defaultTo('entered');
    t.string('void_reason', 60);
    t.timestamp('redeemed_at', { useTz: true });
    t.uuid('credit_ledger_id').unique()
      .references('id').inTable('customer_credit_ledger').onDelete('SET NULL');
    t.timestamps(true, true);

    t.index(['discount_id', 'status']);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX invoice_promo_codes_one_per_customer
      ON invoice_promo_codes (discount_id, customer_id)
      WHERE status = 'redeemed' AND customer_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('invoice_promo_codes');
};
