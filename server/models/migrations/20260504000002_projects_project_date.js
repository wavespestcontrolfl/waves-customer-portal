/**
 * Add an explicit project/inspection date so customer-facing reports can show
 * when the work happened, even if admin sends the report later.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('projects', 'project_date');
  if (!hasColumn) {
    await knex.schema.alterTable('projects', (t) => {
      t.date('project_date');
      t.index('project_date');
    });
  }

  await knex.raw(`
    UPDATE projects p
    SET project_date = COALESCE(sr.service_date, ss.scheduled_date, (p.created_at AT TIME ZONE 'America/New_York')::date)
    FROM projects base
    LEFT JOIN service_records sr ON sr.id = base.service_record_id
    LEFT JOIN scheduled_services ss ON ss.id = base.scheduled_service_id
    WHERE p.id = base.id
      AND p.project_date IS NULL
  `);
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('projects', 'project_date');
  if (hasColumn) {
    await knex.schema.alterTable('projects', (t) => {
      t.dropColumn('project_date');
    });
  }
};
