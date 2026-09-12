/** Renewable delivery ownership and durable health-step success.
 * The published pipeline timestamp migration stays byte-for-byte intact.
 * Existing timestamps retain their meaning; no historical success is inferred.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'pipeline_owner_token'))) {
    await knex.schema.alterTable('lawn_assessment_runs', (t) => t.uuid('pipeline_owner_token').nullable());
  }
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'pipeline_health_completed_at'))) {
    await knex.schema.alterTable('lawn_assessment_runs', (t) => t.timestamp('pipeline_health_completed_at', { useTz: true }).nullable());
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  for (const column of ['pipeline_owner_token', 'pipeline_health_completed_at']) {
    if (await knex.schema.hasColumn('lawn_assessment_runs', column)) {
      await knex.schema.alterTable('lawn_assessment_runs', (t) => t.dropColumn(column));
    }
  }
};
