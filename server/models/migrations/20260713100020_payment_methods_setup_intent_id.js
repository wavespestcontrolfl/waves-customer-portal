'use strict';

/**
 * payment_methods.stripe_setup_intent_id (portal ACH lane, Codex #2706
 * r3): the micro-deposit deferred save must persist a durable handle to
 * its SetupIntent — the hosted verification URL only lived in React
 * state, so a reload left the customer with a permanently pending bank
 * row and no way to confirm the deposits. The resume endpoint
 * (GET /billing/cards/:id/bank-verification-link) rebuilds the link from
 * this id.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payment_methods'))) return;
  if (await knex.schema.hasColumn('payment_methods', 'stripe_setup_intent_id')) return;
  await knex.schema.alterTable('payment_methods', (t) => {
    t.string('stripe_setup_intent_id', 255);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payment_methods'))) return;
  if (!(await knex.schema.hasColumn('payment_methods', 'stripe_setup_intent_id'))) return;
  await knex.schema.alterTable('payment_methods', (t) => {
    t.dropColumn('stripe_setup_intent_id');
  });
};
