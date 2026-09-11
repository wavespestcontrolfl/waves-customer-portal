/**
 * Atomic per-phone claim table for the unknown-sender sms_reply alert
 * window (routes/twilio-webhook.js claimUnknownSenderAlertWindow).
 *
 * Replaces a pooled transaction held (pg_advisory_xact_lock) across the
 * whole notification dispatch — under a burst of distinct unknown senders
 * near DB_POOL_MAX that held-across-dispatch shape let every pool slot end
 * up parked on a transaction waiting for ANOTHER pool acquisition the
 * windowHeld()/ringSmsReplyBell() queries needed, which lock_timeout does
 * not bound (it bounds Postgres lock waits, not pool-connection waits).
 *
 * `phone` is the PRIMARY KEY, so a single `INSERT ... ON CONFLICT DO UPDATE
 * ... WHERE expires_at < now()` claims the current 4h window in one
 * statement with no transaction held across the async dispatch that
 * follows: a fresh insert or an expired-row refresh wins (RETURNING has a
 * row); a still-live window loses (WHERE suppresses the update, RETURNING
 * is empty) — same claim/confirm shape as voicemail_sms_claims and
 * dropped_call_sms_claims, windowed instead of one-shot-ever. The route
 * releases (deletes) a won claim when the dispatch it guarded never
 * actually delivered (thread already read, or no bell/push landed), so a
 * later message in the same window gets another chance.
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('sms_reply_alert_claims')) return;
  await knex.schema.createTable('sms_reply_alert_claims', (t) => {
    t.string('phone', 32).primary();
    t.timestamp('expires_at', { useTz: true }).notNullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('sms_reply_alert_claims');
};
