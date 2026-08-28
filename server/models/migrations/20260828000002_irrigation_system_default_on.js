/**
 * Irrigation ON by default (owner ruling 2026-08-27).
 *
 * The portal's "Irrigation system" toggle is retired — every property is
 * treated as irrigated. The column defaulted to false, so every row a
 * customer ever saved without touching the toggle carries a false that is
 * indistinguishable from a deliberate "no system"; with the toggle gone the
 * customer has no way to change it, while the lawn report and the Monday
 * irrigation email still read the column (suppressing a derived figure and,
 * for the email, asking the customer to switch on a control that no longer
 * exists). Nothing but the retired toggle ever wrote false, so flip every
 * non-true row and move the default. A technician's recorded irrigation
 * type (customer_turf_profiles) still outranks this column in both readers.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  await knex.raw(`
    UPDATE property_preferences
       SET irrigation_system = true
     WHERE irrigation_system IS DISTINCT FROM true
  `);
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT true');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  // The data flip is not reversible (the pre-migration false was the column
  // default, not a customer statement); only the default moves back.
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT false');
};
