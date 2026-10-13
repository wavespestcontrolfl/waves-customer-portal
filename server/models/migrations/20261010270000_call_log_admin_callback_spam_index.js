// The office callbacks a voicemail's spam verdict rests on (GATE_CALLBACK_SPAM_
// CLOSES_PARENT): call-commitments.callbackReachedSolicitor (once per open
// callback promise on every refresh, so thousands per watchdog sweep), the
// processor's standingSpamCallbacks and the triage sweep's callback_spam
// loader all look up call_log by metadata.relatedCallId among rows with source
// admin-callback and processing_status spam. The existing partial index on
// relatedCallId requires callback_policy = 'card', which a Call Log callback
// placed with the card gate off does not carry (codex #6271 r7 P2). Same shape
// as 20260910000001_call_log_callback_linkage_indexes.js.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_admin_callback_spam_related_call_id_index ON call_log ((metadata->>'relatedCallId')) WHERE source = 'admin-callback' AND processing_status = 'spam'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_admin_callback_spam_related_call_id_index');
};
