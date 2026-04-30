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
  // After this migration runs in prod, the table will accumulate multiple
  // 'failed' rows per PI (one per retry attempt). Re-adding the original
  // (payment_intent_id, outcome) PK on raw production data would fail with
  // duplicate-key errors and leave the migration partially rolled back.
  //
  // Consolidate: keep only the most-recently-notified row per (PI, outcome)
  // and drop the older duplicates before restoring the old key. The
  // notification fan-out is informational (one bell entry vs many) — losing
  // older duplicate rows is acceptable rollback semantics; the actual
  // payments table is untouched.
  await knex.raw(`
    DELETE FROM stripe_payment_notification_log a
    USING stripe_payment_notification_log b
    WHERE a.payment_intent_id = b.payment_intent_id
      AND a.outcome = b.outcome
      AND (a.notified_at, a.attempt_id) < (b.notified_at, b.attempt_id)
  `);
  await knex.raw(`ALTER TABLE stripe_payment_notification_log DROP CONSTRAINT stripe_payment_notification_log_pkey`);
  await knex.raw(`ALTER TABLE stripe_payment_notification_log ADD PRIMARY KEY (payment_intent_id, outcome)`);
  await knex.schema.alterTable('stripe_payment_notification_log', (t) => {
    t.dropColumn('attempt_id');
  });
};
