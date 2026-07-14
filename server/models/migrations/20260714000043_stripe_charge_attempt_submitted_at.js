/**
 * Distinguish an acquired saved-card claim from a request that was actually
 * handed to the Stripe SDK. Request economics are prepared before submission,
 * so amount alone cannot prove that Stripe may have seen the charge.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (t) => {
    t.timestamp('submitted_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (t) => {
    t.dropColumn('submitted_at');
  });
};
