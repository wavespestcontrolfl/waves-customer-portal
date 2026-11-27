/**
 * stripe_email_sync_jobs (owner 2026-11-27 "build"): a durable job to copy a customer's confirmed new email onto their
 * linked Stripe customer. Written in the SAME transaction as the app email confirm, so a restart cannot lose it;
 * services/stripe-email-sync.js drains it every minute.
 *
 *   email              the address the customer confirmed; the job writes Stripe only while the record still holds it
 *   status             pending | done | skipped | failed
 *   result             updated | not_linked | superseded | gone | shared | merged | gave_up
 *   attempts           Stripe errors after the profile is linked
 *   not_linked_checks  re-checks of a customer with no Stripe profile yet
 *
 * No unique index on purpose: a customer merge repoints these rows from the retired record to the kept one (the merge
 * FK sweep), and two pending rows for one customer are harmless, since each job locks the customer row and writes the
 * email on file at that moment. enqueue() re-arms a pending row instead of adding one. Additive; down drops the table
 * (pending syncs are lost, the customer record is unchanged).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('stripe_email_sync_jobs')) return;
  await knex.schema.createTable('stripe_email_sync_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('status', 16).notNullable().defaultTo('pending');
    t.string('result', 24);
    t.string('source', 24).notNullable();
    t.string('email', 320).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('not_linked_checks').notNullable().defaultTo(0);
    t.string('last_error', 80);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw("CREATE INDEX stripe_email_sync_jobs_pending_customer ON stripe_email_sync_jobs (customer_id) WHERE status = 'pending'");
  await knex.raw("CREATE INDEX stripe_email_sync_jobs_due ON stripe_email_sync_jobs (next_attempt_at) WHERE status = 'pending'");
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stripe_email_sync_jobs');
};
