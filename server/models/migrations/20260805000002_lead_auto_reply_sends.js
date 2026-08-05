/**
 * Durable per-phone marker for the lead auto-reply (lead_auto_reply_biz).
 *
 * messaging_audit_log is written best-effort AFTER the Twilio send — it can
 * return {id:null} on error, leaving a delivered menu text invisible to the
 * once-per-person dedup in routes/lead-webhook.js (Codex P2 on #3214). This
 * table is the durable claim: the webhook inserts a row inside the same
 * advisory-lock transaction that guards the send, keyed by the last 10
 * phone digits, only when Twilio returned a real message SID.
 *
 * Starts empty — history is covered by the audit-log and frozen sms_log
 * legs of the dedup predicate.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lead_auto_reply_sends')) return;
  await knex.schema.createTable('lead_auto_reply_sends', (t) => {
    t.string('phone_digits', 10).primary();
    t.uuid('customer_id');
    t.string('twilio_sid', 64);
    t.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lead_auto_reply_sends'))) return;
  await knex.schema.dropTable('lead_auto_reply_sends');
};
