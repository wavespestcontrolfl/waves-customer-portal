'use strict';

// Preserve any saved `autopay_pct` KPI target under the new
// `recurring_autopay_pct` key (introduced so recurring-plan autopay coverage
// starts a clean kpi_snapshots trend without splicing onto legacy customer-wide
// `autopay_pct` history). Leaves any already-set `recurring_autopay_pct` row
// untouched and rolls back only the copied row when unmodified.

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
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  const oldAutopay = await knex('kpi_targets').where({ metric: 'autopay_pct' }).first();
  if (!oldAutopay) return;
  await knex('kpi_targets')
    .where({ metric: 'recurring_autopay_pct', updated_at: oldAutopay.updated_at })
    .del();
};
