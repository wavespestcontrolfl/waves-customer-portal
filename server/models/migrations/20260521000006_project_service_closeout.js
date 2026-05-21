/**
 * Project-backed service closeout metadata.
 *
 * Projects are now the primary customer artifact for one-time and
 * documentation-heavy services, while service_records remains the durable
 * "work was completed" audit row. These columns record whether a Project
 * report is allowed to surface in the authenticated customer portal.
 */

exports.up = async function up(knex) {
  const cols = await knex('projects').columnInfo().catch(() => ({}));

  await knex.schema.alterTable('projects', (t) => {
    if (!cols.closed_at) t.timestamp('closed_at');
    if (!cols.portal_visible) t.boolean('portal_visible');
    if (!cols.portal_visibility) t.string('portal_visibility', 40);
    if (!cols.portal_attach_policy) t.string('portal_attach_policy', 60);
    if (!cols.completion_profile_snapshot) t.jsonb('completion_profile_snapshot');
  });

  await knex.raw(`
    ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_portal_visibility_check
  `);
  await knex.raw(`
    ALTER TABLE projects
    ADD CONSTRAINT projects_portal_visibility_check
    CHECK (
      portal_visibility IS NULL
      OR portal_visibility IN ('customer_portal', 'token_only', 'internal_only')
    )
  `);

  await knex.raw(`
    ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_portal_attach_policy_check
  `);
  await knex.raw(`
    ALTER TABLE projects
    ADD CONSTRAINT projects_portal_attach_policy_check
    CHECK (
      portal_attach_policy IS NULL
      OR portal_attach_policy IN ('always', 'active_portal_customer', 'recurring_customer', 'never')
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_projects_scheduled_service_id
    ON projects(scheduled_service_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_projects_customer_portal_visible
    ON projects(customer_id, portal_visible)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_projects_customer_portal_visible');
  await knex.raw('DROP INDEX IF EXISTS idx_projects_scheduled_service_id');
  await knex.raw('ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_portal_attach_policy_check');
  await knex.raw('ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_portal_visibility_check');

  const cols = await knex('projects').columnInfo().catch(() => ({}));
  await knex.schema.alterTable('projects', (t) => {
    if (cols.completion_profile_snapshot) t.dropColumn('completion_profile_snapshot');
    if (cols.portal_attach_policy) t.dropColumn('portal_attach_policy');
    if (cols.portal_visibility) t.dropColumn('portal_visibility');
    if (cols.portal_visible) t.dropColumn('portal_visible');
    if (cols.closed_at) t.dropColumn('closed_at');
  });
};
