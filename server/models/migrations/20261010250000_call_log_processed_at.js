/**
 * Add call_log.processed_at — when the call-processing pipeline reached its
 * terminal verdict for the row (processed, spam, voicemail, or a
 * *_creation_failed verdict that still ends the pass).
 *
 * Why: the 2026-10-09 call-recording audit had to estimate processing
 * latency from updated_at, which every later write moves (review verdicts,
 * triage, bells, relinks), so "recording ready -> processed" could only be
 * read as an upper bound. processing_started_at is DURABLE for the LAST pass
 * (it bounds the bridge-ambiguity phone snapshot) and processing_timings in
 * metadata is per pass; neither is a plain column a report can order by.
 * Only the four terminal-verdict writes in call-recording-processor.js set
 * this; retry lanes (no_transcription, extraction_failed) do not. A later
 * pass that re-reaches a verdict overwrites it: it is "when the current
 * verdict landed", not "first time ever".
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'processed_at')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.timestamp('processed_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'processed_at'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('processed_at');
  });
};
