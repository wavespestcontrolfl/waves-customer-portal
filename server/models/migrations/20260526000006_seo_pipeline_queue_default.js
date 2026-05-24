exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('seo_pipeline_runs'))) return;

  await knex.raw("ALTER TABLE seo_pipeline_runs ALTER COLUMN status SET DEFAULT 'queued'");
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS seo_pipeline_runs_queued_index
    ON seo_pipeline_runs (created_at, id)
    WHERE status = 'queued'
  `);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('seo_pipeline_runs'))) return;

  await knex.raw('DROP INDEX IF EXISTS seo_pipeline_runs_queued_index');
  await knex.raw("ALTER TABLE seo_pipeline_runs ALTER COLUMN status SET DEFAULT 'running'");
};
