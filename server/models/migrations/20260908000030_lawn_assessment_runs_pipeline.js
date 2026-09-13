/**
 * lawn_assessment_runs.pipeline_claimed_at / pipeline_completed_at — the
 * durable claim on a confirmed assessment's customer delivery (Knowledge
 * Bridge recommendations, health signal, standalone notification, service
 * report). /confirm claims the pipeline once before queueing it and marks it
 * complete at the end, so a retry after a process exit between the commit
 * and the queue RESUMES the delivery instead of reading the confirmed row as
 * proof it ran, while a retry after a completed delivery never runs it twice
 * (Codex #4150 r13). Additive; a database without the columns delivers as
 * before (services/lawn-visit-assessment.js claimPipeline).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (await knex.schema.hasColumn('lawn_assessment_runs', 'pipeline_claimed_at')) return;
  await knex.schema.alterTable('lawn_assessment_runs', (t) => {
    t.timestamp('pipeline_claimed_at', { useTz: true }).nullable();
    t.timestamp('pipeline_completed_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'pipeline_claimed_at'))) return;
  await knex.schema.alterTable('lawn_assessment_runs', (t) => {
    t.dropColumn('pipeline_claimed_at');
    t.dropColumn('pipeline_completed_at');
  });
};
