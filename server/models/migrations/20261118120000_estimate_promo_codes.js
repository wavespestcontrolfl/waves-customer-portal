/**
 * Promo code a customer typed on their estimate page (owner-approved build,
 * 2026-11-18: "a one-time account credit", GATE_ESTIMATE_PROMO_CODE).
 *
 * The code is recorded when it is entered and no money moves then: this row
 * is the promise. The credit mints into the customer-credit ledger once,
 * when the estimate is accepted (services/estimate-promo-code.js), so a code
 * on an estimate nobody accepts never becomes a balance. The estimate's own
 * price is never changed.
 *
 * Exactly-once, enforced by the schema (the inspection_credit_offers
 * discipline):
 *   - ONE code per estimate, ever (unique estimate_id)
 *   - ONE mint per row, ever (unique credit_ledger_id)
 *   - ONE redemption of a code per customer (partial unique index)
 *
 * `credit_amount` is FROZEN at entry from the discount row, so a later edit
 * to the discount cannot move a promise already shown to the customer.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimate_promo_codes')) return;

  await knex.schema.createTable('estimate_promo_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().unique()
      .references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('discount_id').notNullable()
      .references('id').inTable('discounts').onDelete('CASCADE');
    // As the discount row spells it (upper case), for the page and the audit trail.
    t.string('code', 50).notNullable();
    t.decimal('credit_amount', 10, 2).notNullable();
    // entered → redeemed | void. Terminal states never regress.
    t.string('status', 24).notNullable().defaultTo('entered');
    // Why a row was voided at acceptance (the code was switched off, its uses
    // ran out, the customer already used it). Audit only.
    t.string('void_reason', 60);
    t.timestamp('redeemed_at', { useTz: true });
    t.uuid('redeemed_customer_id')
      .references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('credit_ledger_id').unique()
      .references('id').inTable('customer_credit_ledger').onDelete('SET NULL');
    t.timestamps(true, true);

    t.index(['discount_id', 'status']);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX estimate_promo_codes_one_per_customer
      ON estimate_promo_codes (discount_id, redeemed_customer_id)
      WHERE status = 'redeemed' AND redeemed_customer_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_promo_codes');
};
