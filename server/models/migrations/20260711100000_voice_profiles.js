/**
 * voice_profiles — Loop 2 of the SMS brand-voice loop.
 *
 * One row = one distilled VOICE PROFILE (style-only markdown describing how
 * Waves' humans actually talk), produced weekly by voice-profile-distiller
 * from the redacted voice_corpus_examples corpus.
 *
 * Lifecycle: pending → approved | rejected; approving a new version flips the
 * previously approved row to superseded, so at most ONE row is ever
 * status='approved' — that row is the only thing consumers
 * (getApprovedVoiceProfile) read. Nothing is auto-applied: the flip is a
 * human click in the Agents hub.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('voice_profiles', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.integer('version').notNullable(); // monotonically increasing, human-facing
    t.text('profile_text').notNullable(); // the distilled markdown (redacted-source, style-only)
    t.jsonb('source_stats'); // { transcripts, smsPairs, newCorpusRows, flags }
    t.string('model', 80); // the model that actually distilled it
    t.string('status', 20).notNullable().defaultTo('pending'); // pending|approved|rejected|superseded
    t.string('reviewed_by', 120);
    t.timestamp('reviewed_at');
    t.string('schema_version', 30).notNullable().defaultTo('voice-profile.v1');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.unique('version');
    t.index('status');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('voice_profiles');
};
