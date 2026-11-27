/**
 * stripe_email_sync_jobs (owner 2026-11-27 "build"): a durable job to copy a customer's current email onto their
 * linked Stripe customer. Written in the SAME transaction as the email change (app confirm, or a first-time Stripe
 * link that raced one), so a restart cannot lose it; services/stripe-email-sync.js drains it every minute.
 *
 *   status   pending | done | skipped | failed
 *   result   updated | not_linked | no_email | not_configured | gone | shared | gave_up
 *
 * One pending row per customer (partial unique index): a second change before the drain only bumps the row, and the
 * drain always reads the email on file at that moment. Additive; down drops the table (pending syncs are lost, the
 * customer record is unchanged).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('stripe_email_sync_jobs')) return;
  await knex.schema.createTable('stripe_email_sync_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('status', 16).notNullable().defaultTo('pending');
    t.string('result', 24);
    t.string('source', 24).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.string('last_error', 80);
    t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });
    t.timestamps(true, true);
  });
  await knex.raw("CREATE UNIQUE INDEX stripe_email_sync_jobs_one_pending ON stripe_email_sync_jobs (customer_id) WHERE status = 'pending'");
  await knex.raw("CREATE INDEX stripe_email_sync_jobs_due ON stripe_email_sync_jobs (next_attempt_at) WHERE status = 'pending'");
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stripe_email_sync_jobs');
};
