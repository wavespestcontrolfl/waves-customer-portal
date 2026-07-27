/**
 * Per-customer record of whether their bait stations are RENTED
 * (owner 2026-07-26).
 *
 * termite_stations.owned_by answers the question per station, but station
 * rows are created at the INSTALL VISIT — long after the estimate that sold
 * the program, and by a code path (completion sync / office PUT) that has no
 * view of the accepted agreement. Without a per-customer fact to read at
 * that moment, every rented station would be written with the 'customer'
 * default and the Waves-owned recovery index would stay empty (codex P1 on
 * this PR).
 *
 * This is the propagation point: estimate conversion stamps it from the
 * accepted rental line, and upsertStationsForCustomer reads it as the
 * default ownership for newly created stations. Explicit per-entry ownership
 * still wins, so a mixed set (bought stations extended with rented ones
 * after an addition) stays representable.
 *
 * Default false: every existing customer predates the rental option, so
 * their stations are purchases by construction — the same reasoning as the
 * termite_stations.owned_by backfill.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'termite_stations_rented')) return;
  await knex.schema.alterTable('customers', (t) => {
    t.boolean('termite_stations_rented').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'termite_stations_rented'))) return;
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('termite_stations_rented');
  });
};
