/**
 * One pinned gate per neighborhood, as a schema backstop for the admin
 * route's check (pre-push audit, 2026-10-24): the day feed's waypoint is "the
 * pinned live entry", so two pinned live entries would leave it to sort
 * order, which could route a visit through the resident gate the pin exists
 * to avoid. Same shape as neighborhood_access_live_code_uniq: live rows only,
 * so a retired pinned entry never blocks the next one.
 *
 * Its own file because 20261025050000 has already run on the PR preview
 * database and cannot be edited.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access'))) return;
  if (!(await knex.schema.hasColumn('neighborhood_access', 'gate_lat'))) return;
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS neighborhood_access_pin_uniq '
    + "ON neighborhood_access (neighborhood_id) WHERE gate_lat IS NOT NULL AND status <> 'retired'"
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS neighborhood_access_pin_uniq');
};
