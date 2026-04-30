/**
 * notification_object_dispatch
 *
 * Object-level idempotency for triggerNotification() calls fired from
 * Stripe webhook handlers. Stripe can emit separate Event objects (with
 * different event.id) for the same underlying object — for example two
 * payment_intent.succeeded events for the same payment_intent.id during
 * a failover or replay. The existing stripe_webhook_events table dedupes
 * on event.id, so it does not catch this case; without object-level
 * dedupe we double-fire the admin bell + push.
 *
 * Primary key is (object_id, event_type) so an INSERT ... ON CONFLICT
 * DO NOTHING is the atomic claim. The first event to arrive wins and
 * triggers the notification; subsequent events with a different event.id
 * but the same (object_id, event_type) get rowcount=0 and skip the
 * trigger.
 *
 * Codex P1, PR #534.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('notification_object_dispatch', (t) => {
    t.string('object_id', 128).notNullable();
    t.string('event_type', 64).notNullable();
    t.timestamp('fired_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['object_id', 'event_type']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('notification_object_dispatch');
};
