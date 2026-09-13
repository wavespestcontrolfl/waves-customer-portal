/**
 * Capture the known context sent to the lawn visit model. Published table
 * and score migrations stay unchanged so existing preview databases upgrade
 * too. Historical runs keep NULL context; their prompt cannot be recovered
 * from today's customer profile or the later service-completion readings.
 * Technician notes are represented only by presence, never their text.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'vision_context'))) {
    await knex.schema.alterTable('lawn_assessment_runs', (t) => {
      t.jsonb('vision_context').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('lawn_assessment_runs', 'technician_notes_present'))) {
    await knex.schema.alterTable('lawn_assessment_runs', (t) => {
      t.boolean('technician_notes_present').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_runs'))) return;
  for (const column of ['vision_context', 'technician_notes_present']) {
    if (await knex.schema.hasColumn('lawn_assessment_runs', column)) {
      await knex.schema.alterTable('lawn_assessment_runs', (t) => t.dropColumn(column));
    }
  }
};
