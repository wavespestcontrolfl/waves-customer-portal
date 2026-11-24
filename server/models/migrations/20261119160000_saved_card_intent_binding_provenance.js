// Earlier workers, failure webhooks, and the cancellation backfill all wrote
// stripe_payment_intent_id. Those rows have no record of which writer supplied
// the ID. Only a charge worker with its own Stripe response may stamp it.
exports.up = async function up(knex) {
  const hasBindingProvenance = await knex.schema.hasColumn(
    'stripe_invoice_charge_attempts', 'stripe_payment_intent_bound_at',
  );
  if (!hasBindingProvenance) {
    await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
      table.timestamp('stripe_payment_intent_bound_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  const hasBindingProvenance = await knex.schema.hasColumn(
    'stripe_invoice_charge_attempts', 'stripe_payment_intent_bound_at',
  );
  if (hasBindingProvenance) {
    await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
      table.dropColumn('stripe_payment_intent_bound_at');
    });
  }
};
