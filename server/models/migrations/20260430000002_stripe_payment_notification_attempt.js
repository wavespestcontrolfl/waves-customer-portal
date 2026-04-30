/**
 * stripe_payment_notification_log — add attempt_id to failure-dedupe key.
 *
 * Codex P1 follow-up to #546.
 *
 * The original (payment_intent_id, outcome) primary key is correct for
 * 'succeeded' (a PI succeeds at most once), but wrong for 'failed':
 * PaymentIntents are reused across retries in this codebase (the
 * /api/pay/:token/update-amount path mutates an existing PI's amount,
 * and the customer can fail again with the same PI). Stripe emits a
 * separate `payment_intent.payment_failed` event per attempt, but the
 * old key suppresses every failure after the first → operator never
 * sees subsequent legitimate failures.
 *
 * Fix: add `attempt_id` to the key. The webhook handler will use
 * `paymentIntent.latest_charge` as attempt_id on failures (each charge
 * attempt is a distinct id). Successes keep a constant 'one_shot' value
 * so their dedupe semantics are unchanged.
 *
 * Existing rows already in the table get attempt_id='one_shot' via the
 * NOT NULL DEFAULT, so the new PK still includes them and ON CONFLICT
 * DO NOTHING keeps working for any in-flight Stripe retries crossing
 * the migration boundary.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('stripe_payment_notification_log', (t) => {
    t.string('attempt_id', 128).notNullable().defaultTo('one_shot');
  });
  await knex.raw(`ALTER TABLE stripe_payment_notification_log DROP CONSTRAINT stripe_payment_notification_log_pkey`);
  await knex.raw(`ALTER TABLE stripe_payment_notification_log ADD PRIMARY KEY (payment_intent_id, outcome, attempt_id)`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE stripe_payment_notification_log DROP CONSTRAINT stripe_payment_notification_log_pkey`);
  await knex.raw(`ALTER TABLE stripe_payment_notification_log ADD PRIMARY KEY (payment_intent_id, outcome)`);
  await knex.schema.alterTable('stripe_payment_notification_log', (t) => {
    t.dropColumn('attempt_id');
  });
};
