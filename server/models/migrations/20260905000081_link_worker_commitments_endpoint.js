/** Expand the existing worker audit endpoint CHECK for the scoped Promise Keeper read. */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_link_worker_requests'))) return;
  await knex.raw('ALTER TABLE seo_link_worker_requests DROP CONSTRAINT IF EXISTS seo_link_worker_requests_endpoint_check');
  await knex.raw("ALTER TABLE seo_link_worker_requests ADD CONSTRAINT seo_link_worker_requests_endpoint_check CHECK (endpoint IN ('claim', 'report', 'vendor_price', 'vendor_login', 'watchdog', 'commitments_read'))");
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('seo_link_worker_requests'))) return;
  // Preserve audit evidence: rollback refuses while the new lane has rows.
  // Revoke the gate first; archive those rows explicitly before schema rollback.
  await knex.raw('ALTER TABLE seo_link_worker_requests DROP CONSTRAINT IF EXISTS seo_link_worker_requests_endpoint_check');
  await knex.raw("ALTER TABLE seo_link_worker_requests ADD CONSTRAINT seo_link_worker_requests_endpoint_check CHECK (endpoint IN ('claim', 'report', 'vendor_price', 'vendor_login', 'watchdog'))");
};
