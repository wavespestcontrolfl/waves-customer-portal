// Required estimate-acceptance deposits (dark until ESTIMATE_DEPOSIT_REQUIRED
// is enabled): one row per Stripe PaymentIntent created for an estimate's
// deposit. The deposit is a flat per-service-class amount ($49 recurring /
// $99 one-time, pricing_config-authoritative), charged before acceptance
// commits, and credited as a negative line item on the first invoice — any
// unapplied remainder rolls forward to later service invoices for the same
// estimate. Status flow: pending → received → credited (or refunding →
// refunded / failed). stripe_payment_intent_id uniqueness makes webhook +
// accept-time verification idempotent against each other.
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('estimate_deposits');
  if (exists) return;

  await knex.schema.createTable('estimate_deposits', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.decimal('amount', 10, 2).notNullable();
    // How much of this deposit has been applied to invoices so far — partial
    // applications (deposit larger than a cheap first invoice) track the
    // consumed slice here, so only the unapplied balance stays available.
    // status flips to 'credited' only when credited_amount reaches amount.
    t.decimal('credited_amount', 10, 2).notNullable().defaultTo(0);
    // Dollars WE refunded on this PI (stale deposit, exempt-path sweep, or an
    // unapplied remainder). The charge.refunded webhook echo of our own
    // refund compares against this to distinguish itself from a genuine
    // dashboard refund of credited money.
    t.decimal('refunded_amount', 10, 2).notNullable().defaultTo(0);
    t.string('stripe_payment_intent_id', 100).notNullable().unique();
    t.string('status', 20).notNullable().defaultTo('pending');
    t.timestamp('received_at', { useTz: true });
    t.uuid('credited_invoice_id');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['estimate_id', 'status'], 'idx_estimate_deposits_estimate_status');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_deposits');
};
