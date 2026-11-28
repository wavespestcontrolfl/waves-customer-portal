'use strict';

// Preserve any saved `autopay_pct` KPI target under the new
// `recurring_autopay_pct` key (introduced so recurring-plan autopay coverage
// starts a clean kpi_snapshots trend without splicing onto legacy customer-wide
// `autopay_pct` history). Records an audit marker when up() inserts the copy
// so down() never deletes a pre-existing `recurring_autopay_pct` row or one
// edited after migration.

const MIGRATION_AUDIT_ACTION = 'migration:kpi_targets_recurring_autopay';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  const oldAutopay = await knex('kpi_targets').where({ metric: 'autopay_pct' }).first();
  if (!oldAutopay) return;
  const existing = await knex('kpi_targets').where({ metric: 'recurring_autopay_pct' }).first();
  if (existing) return;

  await knex('kpi_targets').insert({
    metric: 'recurring_autopay_pct',
    target: oldAutopay.target,
    amber_band_pct: oldAutopay.amber_band_pct,
    lower_is_better: oldAutopay.lower_is_better,
    updated_by: oldAutopay.updated_by,
    updated_at: oldAutopay.updated_at,
  });

  if (await knex.schema.hasTable('audit_log')) {
    await knex('audit_log').insert({
      actor_type: 'system',
      action: MIGRATION_AUDIT_ACTION,
      resource_type: 'kpi_targets',
      metadata: JSON.stringify({
        source_metric: 'autopay_pct',
        target_metric: 'recurring_autopay_pct',
        target: oldAutopay.target,
        amber_band_pct: oldAutopay.amber_band_pct,
        lower_is_better: oldAutopay.lower_is_better,
        updated_by: oldAutopay.updated_by,
        updated_at: oldAutopay.updated_at,
      }),
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;

  const marker = await knex('audit_log')
    .where({ action: MIGRATION_AUDIT_ACTION, resource_type: 'kpi_targets' })
    .orderBy('created_at', 'desc')
    .first();
  if (!marker) return;

  const meta = typeof marker.metadata === 'string' ? JSON.parse(marker.metadata) : (marker.metadata || {});
  const q = knex('kpi_targets').where({
    metric: 'recurring_autopay_pct',
    target: meta.target,
    amber_band_pct: meta.amber_band_pct,
    lower_is_better: meta.lower_is_better,
    updated_at: meta.updated_at,
  });
  if (meta.updated_by == null) q.whereNull('updated_by');
  else q.where({ updated_by: meta.updated_by });
  await q.del();
};
