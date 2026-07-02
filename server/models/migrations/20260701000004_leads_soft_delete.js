/**
 * leads soft delete — `deleted_at` / `deleted_by`.
 *
 * DELETE /api/admin/leads/:id used to HARD-delete the lead row AND its
 * lead_activities audit trail. It now soft-deletes instead: the row is stamped
 * `deleted_at` (+ the acting admin's technician id in `deleted_by`) and every
 * live-lead query excludes stamped rows, so the pipeline/analytics/matchers
 * stop seeing it while the row and its activity history stay recoverable.
 *
 * Mirrors the customers soft-delete (20260401000061_customer_soft_delete.js).
 * Partial index because the overwhelming majority of rows are NOT deleted —
 * same convention as idx_customers_churned_at
 * (20260414000024_dashboard_churn_and_indexes.js).
 *
 * Idempotent (hasTable + hasColumn); no backfill — existing rows stay live.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  const hasDeletedAt = await knex.schema.hasColumn('leads', 'deleted_at');
  if (!hasDeletedAt) {
    await knex.schema.alterTable('leads', (t) => {
      t.timestamp('deleted_at', { useTz: true }).nullable().defaultTo(null);
    });
  }
  const hasDeletedBy = await knex.schema.hasColumn('leads', 'deleted_by');
  if (!hasDeletedBy) {
    await knex.schema.alterTable('leads', (t) => {
      t.uuid('deleted_by').nullable().defaultTo(null);
    });
  }

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_leads_deleted_at ON leads (deleted_at) WHERE deleted_at IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  await knex.raw('DROP INDEX IF EXISTS idx_leads_deleted_at');

  if (await knex.schema.hasColumn('leads', 'deleted_by')) {
    await knex.schema.alterTable('leads', (t) => { t.dropColumn('deleted_by'); });
  }
  if (await knex.schema.hasColumn('leads', 'deleted_at')) {
    await knex.schema.alterTable('leads', (t) => { t.dropColumn('deleted_at'); });
  }
};
