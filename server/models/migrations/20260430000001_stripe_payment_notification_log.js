/**
 * stripe_payment_notification_log — dedupe table for Stripe payment
 * notifications fired into the admin bell + push fan-out.
 *
 * Stripe's at-least-once delivery semantics + multi-event flows (a
 * single real payment can produce both `payment_intent.succeeded`
 * AND `charge.succeeded` Events with distinct event.id values) mean
 * the existing stripe_webhook_events.id-keyed dedupe (at the EVENT
 * level) does not prevent multiple notifications for the same real
 * outcome at the PAYMENT INTENT level. Codex P1 on PR #534: operator
 * sees duplicate bell entries / duplicate urgent failure pages from
 * one real payment.
 *
 * Composite primary key (payment_intent_id, outcome): one row per
 * (PI, outcome) pair. The webhook handler INSERT ... ON CONFLICT
 * DO NOTHING; the RETURNING clause tells us whether we got the
 * claim (i.e. were the first to record this outcome). Only the
 * first claimer fires the notification.
 *
 * Outcome values are 'succeeded' | 'failed'. A PI that initially
 * fails and is later retried to success will produce two rows with
 * the same payment_intent_id but distinct outcomes — both
 * legitimately notified.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('stripe_payment_notification_log', (t) => {
    t.string('payment_intent_id').notNullable();
    t.string('outcome', 20).notNullable();
    t.timestamp('notified_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['payment_intent_id', 'outcome']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('stripe_payment_notification_log');
};
