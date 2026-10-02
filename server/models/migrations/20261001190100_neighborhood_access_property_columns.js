/**
 * Per-column guard for the customer_properties columns added by
 * 20261001190000_neighborhood_access, which checked only neighborhood_id
 * before adding all four. That file has run on preview databases and cannot
 * be edited, so this follow-up adds whichever of the four is missing, one at
 * a time — a schema that drifted to a partial set ends complete.
 *
 * down() is a documented no-op: the columns belong to 20261001190000, whose
 * own down() drops them.
 */

const COLUMNS = [
  ['neighborhood_id', (t) => t.uuid('neighborhood_id').references('id').inTable('neighborhoods').onDelete('SET NULL')],
  ['neighborhood_source', (t) => t.string('neighborhood_source', 20)],
  ['county_subdivision', (t) => t.string('county_subdivision', 200)],
  ['neighborhood_checked_at', (t) => t.timestamp('neighborhood_checked_at', { useTz: true })],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties')) || !(await knex.schema.hasTable('neighborhoods'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('customer_properties', name))) {
      await knex.schema.alterTable('customer_properties', (t) => add(t));
    }
  }
};

exports.down = async function down() {
  // No-op by design — see the header.
};
