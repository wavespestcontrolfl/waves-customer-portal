// One-time card-on-file holds (dark until ONE_TIME_CARD_HOLD). One row per
// SetupIntent created to capture a card that RESERVES a one-time visit. Unlike
// estimate_deposits, NO money is taken at booking: the card is saved via a
// SetupIntent, then charged the final service total on completion, and a flat
// no-show / late-cancel fee only if the customer cancels inside the window or
// isn't home. Status flow: pending (intent minted) → held (card captured +
// estimate accepted) → charged_completion / charged_no_show / released /
// failed. stripe_setup_intent_id uniqueness makes webhook + accept-time
// verification idempotent against each other (same discipline as
// estimate_deposits.stripe_payment_intent_id).
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('estimate_card_holds');
  if (exists) return;

  await knex.schema.createTable('estimate_card_holds', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    // The booked one-time appointment this hold protects. Set at accept time
    // once the slot is committed; the completion and no-show charge triggers
    // resolve the hold from here.
    t.uuid('scheduled_service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');
    // The SetupIntent that captured the card. Pins the hold to this estimate
    // via metadata and is the idempotency anchor for webhook + accept verify.
    t.string('stripe_setup_intent_id', 100).notNullable().unique();
    // The saved Stripe payment method we charge later (completion + no-show).
    t.string('stripe_payment_method_id', 100);
    // Frozen at agreement time so a later constants/pricing_config change never
    // moves the fee a customer already consented to.
    t.decimal('no_show_fee_amount', 10, 2);
    t.integer('cancel_window_hours');
    // When the customer consented to the card hold + fee terms at booking —
    // the disclosure-and-consent record that makes the fee enforceable.
    t.timestamp('agreed_at', { useTz: true });
    t.string('status', 24).notNullable().defaultTo('pending');
    // Off-session charge PaymentIntents (completion total / no-show fee) — kept
    // for idempotency, receipts, and reconciliation. Nullable until charged.
    t.string('completion_payment_intent_id', 100);
    t.string('no_show_payment_intent_id', 100);
    t.decimal('charged_amount', 10, 2);
    t.timestamp('held_at', { useTz: true });
    t.timestamp('charged_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['estimate_id', 'status'], 'idx_estimate_card_holds_estimate_status');
    t.index(['scheduled_service_id'], 'idx_estimate_card_holds_scheduled_service');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_card_holds');
};
