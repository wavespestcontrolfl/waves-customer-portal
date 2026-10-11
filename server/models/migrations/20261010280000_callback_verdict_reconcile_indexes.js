// The commitments watchdog reconciles callback-spam settlements whose
// callback since settled on another verdict (call-recording-processor
// reconcileCorrectedCallbackVerdicts, GATE_CALLBACK_SPAM_CLOSES_PARENT): it
// scans the parents still carrying a callback_verdict stamp and the promises
// still dismissed on callback_spam evidence. Both scans read a small set
// through a partial index (codex #6271 r13 P1). Same shape as
// 20260910000001_call_log_callback_linkage_indexes.js.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('call_log')) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS call_log_callback_verdict_callback_id_index ON call_log ((metadata->'callback_verdict'->>'callback_call_log_id')) WHERE metadata->'callback_verdict' IS NOT NULL",
    );
  }
  if (await knex.schema.hasTable('call_commitments')) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS call_commitments_callback_spam_dismissed_index ON call_commitments ((fulfillment->>'record_id')) WHERE status = 'dismissed' AND fulfillment->>'kind' = 'callback_spam'",
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_callback_verdict_callback_id_index');
  await knex.raw('DROP INDEX IF EXISTS call_commitments_callback_spam_dismissed_index');
};
