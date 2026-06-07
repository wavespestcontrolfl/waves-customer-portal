exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_requests'))) return;

  const columns = {
    estimate_id: await knex.schema.hasColumn('service_requests', 'estimate_id'),
    requested_service: await knex.schema.hasColumn('service_requests', 'requested_service'),
    source: await knex.schema.hasColumn('service_requests', 'source'),
    pricing_revision: await knex.schema.hasColumn('service_requests', 'pricing_revision'),
  };

  await knex.schema.alterTable('service_requests', (t) => {
    if (!columns.estimate_id) {
      t.uuid('estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
    }
    if (!columns.requested_service) t.string('requested_service', 80);
    if (!columns.source) t.string('source', 80);
    if (!columns.pricing_revision) t.jsonb('pricing_revision').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_service_requests_estimate_id
      ON service_requests (estimate_id)
      WHERE estimate_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_service_requests_source_status
      ON service_requests (source, status)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_service_requests_open_estimate_requested_service
      ON service_requests (estimate_id, requested_service)
      WHERE estimate_id IS NOT NULL
        AND requested_service IS NOT NULL
        AND COALESCE(status, 'new') NOT IN ('resolved', 'closed', 'cancelled')
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_requests'))) return;

  await knex.raw('DROP INDEX IF EXISTS uniq_service_requests_open_estimate_requested_service');
  await knex.raw('DROP INDEX IF EXISTS idx_service_requests_source_status');
  await knex.raw('DROP INDEX IF EXISTS idx_service_requests_estimate_id');

  const columns = {
    pricing_revision: await knex.schema.hasColumn('service_requests', 'pricing_revision'),
    source: await knex.schema.hasColumn('service_requests', 'source'),
    requested_service: await knex.schema.hasColumn('service_requests', 'requested_service'),
    estimate_id: await knex.schema.hasColumn('service_requests', 'estimate_id'),
  };

  await knex.schema.alterTable('service_requests', (t) => {
    if (columns.pricing_revision) t.dropColumn('pricing_revision');
    if (columns.source) t.dropColumn('source');
    if (columns.requested_service) t.dropColumn('requested_service');
    if (columns.estimate_id) t.dropColumn('estimate_id');
  });
};
