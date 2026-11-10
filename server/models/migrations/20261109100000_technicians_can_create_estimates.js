'use strict';

/**
 * technicians.can_create_estimates — may this technician price an estimate from the field
 * (owner 2026-11-09, "GO, FOR ALL": the technician estimate tool). Read only behind
 * GATE_TECH_ESTIMATES (routes/tech-estimates.js): with the gate on, a technician whose row
 * reads false gets the same 404 {enabled:false} as with the gate off. Admins always pass.
 *
 * Every existing row starts false (the column default): the owner switches a technician on in
 * the Team tab (PUT /admin/timetracking/technicians/:id, `canCreateEstimates`). Additive and
 * idempotent (hasColumn guard in both directions).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'can_create_estimates')) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.boolean('can_create_estimates').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'can_create_estimates'))) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('can_create_estimates');
  });
};
