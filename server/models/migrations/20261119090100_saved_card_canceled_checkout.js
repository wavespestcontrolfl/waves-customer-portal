exports.up = async function up(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
    table.string('canceled_checkout_payment_intent_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('stripe_invoice_charge_attempts', (table) => {
    table.dropColumn('canceled_checkout_payment_intent_id');
  });
};
