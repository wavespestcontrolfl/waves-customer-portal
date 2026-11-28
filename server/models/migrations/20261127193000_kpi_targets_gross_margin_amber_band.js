'use strict';

// Align untouched default gross_margin amber_band_pct (seeded at 10%) so the
// KPI tile warning floor (45% against the 55% target: 55 * 18.19% = 10.0045)
// matches Margin by Service Line's 45% floor. Leaves owner-edited rows intact.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  await knex('kpi_targets')
    .where({ metric: 'gross_margin', target: 55, amber_band_pct: 10 })
    .whereNull('updated_by')
    .update({ amber_band_pct: 18.19, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  await knex('kpi_targets')
    .where({ metric: 'gross_margin', target: 55, amber_band_pct: 18.19 })
    .whereNull('updated_by')
    .update({ amber_band_pct: 10, updated_at: knex.fn.now() });
};
