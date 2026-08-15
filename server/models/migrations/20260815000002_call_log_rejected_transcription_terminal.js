// Rejected implausible transcriptions (hallucination guard) used to finalize
// every column EXCEPT transcription_status, stranding the row at 'pending'
// forever — 47 prod rows since 2026-07-13. The processor now stamps the
// terminal 'rejected' at rejection time; this backfills the strandees.
// Identity predicate = the guard's own stamp (transcription_metadata
// .transcription_rejected), not the sentinel text, so a future sentinel-copy
// change can't orphan the backfill.

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasMeta = await knex.schema.hasColumn('call_log', 'transcription_metadata');
  if (!hasMeta) return;
  await knex('call_log')
    .where('transcription_status', 'pending')
    .whereRaw("transcription_metadata->>'transcription_rejected' = 'true'")
    .update({ transcription_status: 'rejected', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('call_log');
  if (!hasTable) return;
  const hasMeta = await knex.schema.hasColumn('call_log', 'transcription_metadata');
  if (!hasMeta) return;
  await knex('call_log')
    .where('transcription_status', 'rejected')
    .whereRaw("transcription_metadata->>'transcription_rejected' = 'true'")
    .update({ transcription_status: 'pending', updated_at: knex.fn.now() });
};
