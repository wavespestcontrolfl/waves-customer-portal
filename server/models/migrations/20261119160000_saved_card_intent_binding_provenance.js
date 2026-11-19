// Repair databases that ran the original cancellation backfill, which could
// copy a canceled PI into an attempt that the charge worker had never bound.
// A different or absent cancellation ID proves the existing PI did not come
// from that copy. An equal pair remains untrusted because its history is
// ambiguous; the original worker may bind it again and stamp provenance.
exports.up = async function up(knex) {
  const hasBindingProvenance = await knex.schema.hasColumn(
    'stripe_invoice_charge_attempts', 'stripe_payment_intent_bound_at',
  );
  if (!hasBindingProvenance) {
    await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
      table.timestamp('stripe_payment_intent_bound_at', { useTz: true });
    });
  }

  await knex('stripe_invoice_charge_attempts')
    .whereNotNull('stripe_payment_intent_id')
    .where((query) => query.whereNull('authentication_canceled_intent_id')
      .orWhereColumn('authentication_canceled_intent_id', '<>', 'stripe_payment_intent_id'))
    .whereNull('stripe_payment_intent_bound_at')
    .update({ stripe_payment_intent_bound_at: knex.ref('updated_at') });
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
