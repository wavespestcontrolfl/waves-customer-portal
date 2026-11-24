// Only the worker that received a create error without an intent sets this.
// A checkout that merely promotes a stale submitted claim leaves it null.
exports.up = (knex) => knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
  table.timestamp('worker_create_timed_out_at', { useTz: true });
});

exports.down = (knex) => knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
  table.dropColumn('worker_create_timed_out_at');
});
