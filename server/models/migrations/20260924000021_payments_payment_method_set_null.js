/**
 * Bug (confirmed in prod 2026-09-24): portal DELETE /api/billing/cards/:id
 * (StripeService.removeCard) detaches the payment method at Stripe FIRST,
 * then deletes the local payment_methods row. `payments_payment_method_id_
 * foreign` (20260401000001) carries no ON DELETE action, so a card that has
 * ever been used for a payment can never be deleted — the delete throws,
 * the route 500s, the transaction rolls back, but the Stripe detach already
 * happened. Result: a payment_methods row left pointing at a payment method
 * that no longer exists at Stripe. 62 distinct payment methods in prod have
 * payments rows and are stuck this way.
 *
 * Every other FK onto payment_methods (payment_method_consents,
 * customer_contracts, stripe_invoice_charge_attempts,
 * appointment_card_requests) is already ON DELETE SET NULL. payments
 * already snapshots card_brand/last_four/card_funding/card_country at
 * write time (see 20260401000101 and later), so a payment's own history
 * is unaffected by nulling the pointer — only the live join to the (now
 * gone) card is dropped, exactly like the other four FKs.
 *
 * payments.payment_method_id was never made NOT NULL (confirmed against
 * schema — no follow-up migration added that constraint), so no separate
 * nullability change is needed here.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  if (!(await knex.schema.hasColumn('payments', 'payment_method_id'))) return;

  await knex.schema.alterTable('payments', (t) => {
    t.dropForeign('payment_method_id', 'payments_payment_method_id_foreign');
  });
  await knex.schema.alterTable('payments', (t) => {
    t.foreign('payment_method_id', 'payments_payment_method_id_foreign')
      .references('id')
      .inTable('payment_methods')
      .onDelete('SET NULL');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  if (!(await knex.schema.hasColumn('payments', 'payment_method_id'))) return;

  await knex.schema.alterTable('payments', (t) => {
    t.dropForeign('payment_method_id', 'payments_payment_method_id_foreign');
  });
  await knex.schema.alterTable('payments', (t) => {
    t.foreign('payment_method_id', 'payments_payment_method_id_foreign')
      .references('id')
      .inTable('payment_methods');
  });
};
