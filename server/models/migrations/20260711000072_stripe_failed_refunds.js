/**
 * stripe_failed_refunds — durable pre-settlement fence for bounced refunds
 * with NO payments row (invoice/statement charges whose refund.failed
 * outran both the settlement row and the charge.refunded creation event).
 * Estimate deposits fence on their own ledger (failed_refund_ids); every
 * other no-row bounce records the refund id here so handleChargeRefunded
 * can refuse the late creation event instead of stamping/terminalizing for
 * money Stripe kept.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('stripe_failed_refunds')) return;
  await knex.schema.createTable('stripe_failed_refunds', (t) => {
    t.string('stripe_refund_id', 100).primary();
    t.string('stripe_charge_id', 100);
    t.string('stripe_payment_intent_id', 100);
    t.string('context', 100);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('stripe_failed_refunds'))) return;
  await knex.schema.dropTable('stripe_failed_refunds');
};
