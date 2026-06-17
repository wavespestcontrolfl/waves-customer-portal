/**
 * Phase 3: per-feature live-provider override (the "flip").
 *
 * Absence of a row = the feature's BASELINE provider (estimate→anthropic,
 * call_extraction→gemini) — i.e. today's behavior. A row is written ONLY by the
 * gated Intelligence Bar promote tool after a server-side readiness re-check, so
 * the candidate (e.g. openai) becomes the live provider with the prior one as
 * automatic fallback. Mirrors sms_intent_modes (operator-flipped, DB-backed).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('model_provider_modes')) return;
  await knex.schema.createTable('model_provider_modes', (t) => {
    t.string('feature_key', 60).primary();      // 'estimate_assistant' | 'call_extraction'
    t.string('live_provider', 30).notNullable(); // 'anthropic' | 'gemini' | 'openai'
    t.string('promoted_by', 120).nullable();
    t.text('reason').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('model_provider_modes');
};
