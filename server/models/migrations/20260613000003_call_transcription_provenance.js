/**
 * Store transcription provenance for call recording processing.
 *
 * Transcript text alone is not enough to debug extraction mistakes: we need to
 * know which provider/model produced it, whether speaker relabeling ran, and
 * whether the transcript came from a fallback path.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.string('transcription_provider', 50);
    t.string('transcription_model', 80);
    t.jsonb('transcription_metadata');
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS call_log_transcription_provider_idx
    ON call_log (transcription_provider, created_at DESC)
    WHERE transcription_provider IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_transcription_provider_idx');
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('transcription_provider');
    t.dropColumn('transcription_model');
    t.dropColumn('transcription_metadata');
  });
};
