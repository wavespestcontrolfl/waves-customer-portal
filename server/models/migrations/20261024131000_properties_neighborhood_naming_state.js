/**
 * customer_properties.neighborhood_naming: where the neighborhood naming pass
 * (services/neighborhood-naming.js, GATE_NEIGHBORHOOD_NAMING) last got to with
 * a home, so a home it cannot name never blocks the homes behind it.
 *
 * One nullable jsonb column the pass owns, nothing else reads it:
 *   { addr, county_at, county_answered, caller_at }
 *   addr             md5(address_line1 || '|' || zip) the state was written for;
 *                    a state whose addr no longer matches the row (the address
 *                    moved) counts as no state, so nothing needs clearing on a move.
 *   county_at        ISO time of the last county lookup for this home.
 *   county_answered  true = the county answered without naming it (a day's
 *                    wait); false = the lookup failed (an hour's wait).
 *   caller_at        ISO time of the last attempt to name it from a call.
 * The pass selects only homes past their wait, least recently tried first, in
 * SQL before its LIMIT, so the state survives a restart and a run of
 * unnameable homes cannot hold the head of the queue.
 *
 * Additive and guarded. down() drops the column.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (await knex.schema.hasColumn('customer_properties', 'neighborhood_naming')) return;
  await knex.schema.alterTable('customer_properties', (t) => {
    t.jsonb('neighborhood_naming');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'neighborhood_naming'))) return;
  await knex.schema.alterTable('customer_properties', (t) => {
    t.dropColumn('neighborhood_naming');
  });
};
