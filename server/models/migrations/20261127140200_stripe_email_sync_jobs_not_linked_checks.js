/**
 * stripe_email_sync_jobs.not_linked_checks: how many times the sync re-checked a customer with no Stripe profile yet
 * (services/stripe-email-sync.js), counted apart from Stripe errors (attempts). Additive; down drops the column.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('stripe_email_sync_jobs', 'not_linked_checks')) return;
  await knex.schema.alterTable('stripe_email_sync_jobs', (t) => { t.integer('not_linked_checks').notNullable().defaultTo(0); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('stripe_email_sync_jobs', 'not_linked_checks'))) return;
  await knex.schema.alterTable('stripe_email_sync_jobs', (t) => { t.dropColumn('not_linked_checks'); });
};
