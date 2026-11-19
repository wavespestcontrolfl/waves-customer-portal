// A previous webhook can replace the general intent column after a worker
// timestamps it. Historical rows have no independent copy of the returned ID.
exports.up = (knex) => knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
  table.string('worker_payment_intent_id');
});

exports.down = (knex) => knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
  table.dropColumn('worker_payment_intent_id');
});
