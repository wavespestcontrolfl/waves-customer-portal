/**
 * Add call_log.processing_token — owner fence for the call recording
 * processor's lock release.
 *
 * Background — the atomic claim in CallRecordingProcessor.processRecording
 * sets processing_status='processing' and the new try/catch needs to
 * release that lock on unhandled errors. Fencing on updated_at is
 * unsafe because external code paths (e.g. the Twilio transcription
 * webhook in twilio-voice-webhook.js:242-246) bump updated_at without
 * owning the lock — that breaks the fence and wedges the row.
 *
 * processing_token is written ONLY by the processor: a fresh random hex
 * at claim time, cleared on terminal status writes, and matched in the
 * catch-block release. No other code touches it.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'processing_token')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.string('processing_token', 64);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'processing_token'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('processing_token');
  });
};
