'use strict';

/**
 * technicians.can_move_visits — may this technician move their own visits from
 * the field (owner 2026-10-25: a per-technician "can move visits" switch, the way
 * ServiceTitan gates technician rescheduling).
 *
 * Read only behind GATE_TECH_MOVE_SWITCH (scheduling/tech-move-permission.js):
 * with the gate on, a non-admin caller whose row reads false is refused on the
 * routes that move a visit (Quick Move in the tech app, Quick Move and
 * Reschedule from the admin dispatch routes). Admins are never refused.
 *
 * Every technician that exists when this runs keeps today's behavior (true). A
 * technician added later starts at the column default, false, until the owner
 * switches it on in the Team tab (PUT /admin/timetracking/technicians/:id,
 * `canMoveVisits`). Additive, idempotent (hasColumn guard): a re-run never
 * backfills again, so it cannot undo a switch the owner turned off.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'can_move_visits')) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.boolean('can_move_visits').notNullable().defaultTo(false);
  });
  await knex('technicians').update({ can_move_visits: true });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'can_move_visits'))) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('can_move_visits');
  });
};
