/**
 * inbound_webhook_events — idempotency ledger for inbound Twilio webhooks.
 *
 * Twilio can deliver the same inbound message/call webhook more than once
 * (its own edge retries, a configured FallbackUrl re-hitting the same
 * handler, or a slow handler that exceeds the ~15s timeout while still
 * running). Without a dedupe key, a redelivered MessageSid re-inserts
 * sms_log, re-fires the owner alert, and sends a SECOND AI auto-reply to
 * the customer (RED audit R1).
 *
 * The handlers claim the SID here with INSERT ... ON CONFLICT DO NOTHING
 * before doing any side-effecting work: the first delivery wins the claim
 * and proceeds; a redelivery sees the conflict and short-circuits. The
 * Twilio SID (MessageSid / CallSid) is globally unique per message and is
 * never reused, so claiming on it is safe.
 *
 * Rows are pruned after a short retention window by the scheduler — the
 * retry horizon for Twilio webhooks is minutes/hours, never days.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('inbound_webhook_events')) return;
  await knex.schema.createTable('inbound_webhook_events', (t) => {
    t.string('twilio_sid', 64).primary();
    t.string('channel', 16).notNullable(); // 'sms' | 'voice'
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index('created_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('inbound_webhook_events');
};
