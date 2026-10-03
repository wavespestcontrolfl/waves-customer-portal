/**
 * Per-column guard for the neighborhood_access columns added by
 * 20261003100000_neighborhood_access_tech_actions, which checked only
 * source_technician_id before adding all three. That file has run on preview
 * databases and cannot be edited, so this follow-up adds whichever of the
 * three is missing, one at a time: a schema that drifted to a partial set
 * ends complete.
 *
 * down() is a documented no-op: the columns belong to 20261003100000, whose
 * own down() drops them.
 */

const COLUMNS = [
  ['source_technician_id', (t) => t.uuid('source_technician_id').references('id').inTable('technicians').onDelete('SET NULL')],
  ['flagged_wrong_at', (t) => t.timestamp('flagged_wrong_at', { useTz: true })],
  ['flagged_wrong_by', (t) => t.uuid('flagged_wrong_by').references('id').inTable('technicians').onDelete('SET NULL')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhood_access'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('neighborhood_access', name))) {
      await knex.schema.alterTable('neighborhood_access', (t) => add(t));
    }
  }
};

exports.down = async function down() {
  // No-op by design: see the header.
};
