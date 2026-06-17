/**
 * Phase 3: add LLM-judge verdict columns to ai_model_comparisons.
 * The judge scores each shadow pair (live vs candidate); these columns hold its
 * verdict so the graduation service can compute promotion readiness. Additive +
 * idempotent. Unjudged rows = judge_verdict IS NULL (anti-join).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('ai_model_comparisons', 'judge_verdict')) return;
  await knex.schema.alterTable('ai_model_comparisons', (t) => {
    // candidate_better | equivalent | live_better | candidate_unsafe
    t.string('judge_verdict', 30).nullable();
    t.integer('judge_score').nullable();      // 0–100 (candidate quality vs live)
    t.text('judge_notes').nullable();
    t.string('judge_model', 80).nullable();
    t.timestamp('judged_at', { useTz: true }).nullable();
    t.index(['feature_key', 'judged_at'], 'idx_amc_feature_judged');     // anti-join + recent window
    t.index(['feature_key', 'judge_verdict'], 'idx_amc_feature_verdict');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('ai_model_comparisons', 'judge_verdict'))) return;
  await knex.schema.alterTable('ai_model_comparisons', (t) => {
    t.dropIndex(['feature_key', 'judged_at'], 'idx_amc_feature_judged');
    t.dropIndex(['feature_key', 'judge_verdict'], 'idx_amc_feature_verdict');
    t.dropColumn('judge_verdict');
    t.dropColumn('judge_score');
    t.dropColumn('judge_notes');
    t.dropColumn('judge_model');
    t.dropColumn('judged_at');
  });
};
