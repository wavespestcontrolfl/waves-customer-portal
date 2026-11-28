'use strict';

// Align untouched default gross_margin KPI target (seeded at 40% on 2026-07-02)
// with company_financials.target_gross_margin_pct (55%) and the Margin by
// Service Line card's 45% floor. Leaves any owner-edited row untouched.

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  await knex('kpi_targets')
    .where({ metric: 'gross_margin', target: 40 })
    .whereNull('updated_by')
    .update({ target: 55, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) return;
  await knex('kpi_targets')
    .where({ metric: 'gross_margin', target: 55 })
    .whereNull('updated_by')
    .update({ target: 40, updated_at: knex.fn.now() });
};
