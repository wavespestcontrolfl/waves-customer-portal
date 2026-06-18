/**
 * Drop the shadow model-comparison store.
 *
 * The competing-model (shadow) machinery has been removed: the best models
 * (GPT-5.5 / Gemini 3.5 Flash) are now the LIVE models directly, each with an
 * automatic fallback to the prior provider. There is no longer a candidate to
 * log against a live run, so `ai_model_comparisons` (added 20260617090000) is
 * dropped. `down` recreates it for reversibility.
 */
exports.up = async function up(knex) {
  await knex.schema.dropTableIfExists('ai_model_comparisons');
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('ai_model_comparisons')) return;
  await knex.schema.createTable('ai_model_comparisons', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.string('feature_key', 60).notNullable();
    t.string('entity_type', 40).nullable();
    t.string('entity_id', 64).nullable();

    t.string('live_provider', 30).nullable();
    t.string('live_model', 80).nullable();
    t.text('live_output').nullable();
    t.integer('live_ms').nullable();

    t.string('candidate_provider', 30).nullable();
    t.string('candidate_model', 80).nullable();
    t.text('candidate_output').nullable();
    t.integer('candidate_ms').nullable();
    t.boolean('candidate_ok').notNullable().defaultTo(false);
    t.string('candidate_reason', 60).nullable();

    t.string('agreement_level', 30).nullable();
    t.integer('agreement_score').nullable();
    t.jsonb('divergence').nullable();

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['feature_key', 'created_at']);
    t.index(['agreement_level']);
  });
};
