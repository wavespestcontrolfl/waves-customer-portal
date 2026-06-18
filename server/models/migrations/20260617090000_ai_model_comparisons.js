/**
 * Shadow model-comparison store (Phase 2 cross-provider routing).
 *
 * One row per shadow run: the LIVE model's output next to a CANDIDATE (OpenAI/Gemini)
 * output + a deterministic agreement signal. The candidate never drives customer output
 * or call routing — this accrues evidence so a provider flip can be made later.
 * Modeled on route_decisions (the mode='shadow' audit precedent).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ai_model_comparisons')) return;
  await knex.schema.createTable('ai_model_comparisons', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    t.string('feature_key', 60).notNullable();   // e.g. 'estimate_assistant', 'call_extraction'
    t.string('entity_type', 40).nullable();       // 'estimate' | 'call' | ...
    t.string('entity_id', 64).nullable();         // not a FK — features span tables

    // Live (production) run
    t.string('live_provider', 30).nullable();     // 'anthropic' | 'gemini' | 'openai'
    t.string('live_model', 80).nullable();
    t.text('live_output').nullable();             // text or stringified JSON
    t.integer('live_ms').nullable();

    // Candidate (shadow) run
    t.string('candidate_provider', 30).nullable();
    t.string('candidate_model', 80).nullable();
    t.text('candidate_output').nullable();
    t.integer('candidate_ms').nullable();
    t.boolean('candidate_ok').notNullable().defaultTo(false);
    t.string('candidate_reason', 60).nullable();  // fail-closed reason when !ok

    // Deterministic agreement signal (not a verdict — for later review/LLM judge)
    t.string('agreement_level', 30).nullable();   // identical | similar | divergent | candidate_failed
    t.integer('agreement_score').nullable();      // 0–100
    t.jsonb('divergence').nullable();             // list of differing fields (structured) or null

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['feature_key', 'created_at']);
    t.index(['agreement_level']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_model_comparisons');
};
