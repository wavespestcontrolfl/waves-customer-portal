/**
 * Where a neighborhood gate is on the map (owner 2026-10-24: "go ahead and
 * build this out"). Google Maps picks a gated community's entrance from the
 * house address and often lands a visitor at a resident-only gate; a pin on
 * the shared gate entry lets every visit's Directions link route through the
 * main gate first, with no change to what the technician taps.
 *
 * Set by the office on the Gate codes page (a pasted Google Maps link or
 * "lat, lng"); read by the day feed (routes/admin-schedule.js gateWaypoint).
 * Both columns or neither: the route writes them together.
 */

const COLUMNS = [
  ['gate_lat', (t) => t.decimal('gate_lat', 9, 6)],
  ['gate_lng', (t) => t.decimal('gate_lng', 9, 6)],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('neighborhood_access', name))) {
      await knex.schema.alterTable('neighborhood_access', (t) => add(t));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access'))) return;
  for (const [name] of COLUMNS) {
    if (await knex.schema.hasColumn('neighborhood_access', name)) {
      await knex.schema.alterTable('neighborhood_access', (t) => t.dropColumn(name));
    }
  }
};
