/**
 * Durable idempotency attempts for manual Stripe payouts.
 *
 * Stripe idempotency is keyed at the API layer, but we still need a durable
 * local record before calling Stripe so a retry after a process restart can
 * safely bypass a stale local balance snapshot and reach Stripe with the same
 * key.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('stripe_payout_idempotency_attempts')) return;

  await knex.schema.createTable('stripe_payout_idempotency_attempts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('idempotency_key', 120).notNullable().unique();
    t.string('method', 20).notNullable();
    t.bigInteger('amount_cents').notNullable();
    t.string('requested_by', 120);
    t.string('stripe_payout_id', 120);
    t.string('status', 20).notNullable().defaultTo('attempted');
    t.timestamps(true, true);

    t.index(['method', 'status', 'created_at']);
    t.index(['stripe_payout_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('stripe_payout_idempotency_attempts');
};
