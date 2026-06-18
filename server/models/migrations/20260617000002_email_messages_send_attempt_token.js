/**
 * Per-send-attempt token for email_messages.
 *
 * The SendGrid event webhook can resolve a tracked send by the echoed
 * custom_args.email_message_id before its provider_message_id is written. But an
 * idempotent send that is RETRIED reuses the same email_messages.id (the
 * idempotency_key is unique) and clears provider_message_id while the new request
 * is in flight — so a delayed event from a PRIOR attempt would otherwise bind to
 * the current attempt's row and mis-terminalize it or mis-trigger recovery.
 *
 * send_attempt_token is a fresh value per send attempt, stamped on the row and
 * echoed in custom_args. The webhook fallback requires it to match before trusting
 * an unbound row, so a stale prior-attempt event is rejected. Mirrors the
 * newsletter path's send_attempt_token discriminator.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.string('send_attempt_token');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.dropColumn('send_attempt_token');
  });
};
