/**
 * lawn_assessment_runs.scores_adjusted — the AI scores exactly as presented
 * to the technician: legacy units, seasonally adjusted at /assess.
 * Immutable; /confirm calibrates the technician's corrections against this
 * snapshot, never the assessment row a confirm rewrites (Codex #4150 r5 /
 * #4153 r3). Additive; a run written before this column derives the
 * unadjusted values from scores_raw (services/lawn-visit-assessment.js
 * runAiScores).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (await knex.schema.hasColumn('lawn_assessment_runs', 'scores_adjusted')) return;
  await knex.schema.alterTable('lawn_assessment_runs', (t) => {
    t.jsonb('scores_adjusted').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'scores_adjusted'))) return;
  await knex.schema.alterTable('lawn_assessment_runs', (t) => {
    t.dropColumn('scores_adjusted');
  });
};
