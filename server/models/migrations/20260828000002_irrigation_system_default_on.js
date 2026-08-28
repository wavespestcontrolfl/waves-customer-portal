/**
 * Irrigation ON by default (owner ruling 2026-08-27).
 *
 * The portal's "Irrigation system" toggle is retired — every property is
 * treated as irrigated unless staff say otherwise. The lawn report and the
 * Monday irrigation email still read property_preferences.irrigation_system
 * and suppress a DERIVED weekly-inches figure when it is false, so rows the
 * old toggle left at false while the customer had already entered runtime
 * inputs (minutes, days, head type, explicit inches, zones…) would keep
 * hiding a figure the customer actually supplied. Flip exactly those rows;
 * rows with no irrigation inputs at all have nothing to derive and are left
 * untouched (the route stamps true on their next irrigation write).
 *
 * Column default moves to true for rows created outside the route.
 */
const IRRIGATION_INPUT_PREDICATE = `
  irrigation_run_minutes IS NOT NULL
  OR irrigation_inches_per_week > 0
  OR COALESCE(irrigation_zones, 0) > 0
  OR (watering_days IS NOT NULL AND jsonb_typeof(watering_days) = 'array' AND jsonb_array_length(watering_days) > 0)
  OR (irrigation_system_type IS NOT NULL AND jsonb_typeof(irrigation_system_type) = 'array' AND jsonb_array_length(irrigation_system_type) > 0)
  OR NULLIF(BTRIM(irrigation_controller_location), '') IS NOT NULL
  OR NULLIF(BTRIM(irrigation_schedule_notes), '') IS NOT NULL
  OR rain_sensor = true
`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  await knex.raw(`
    UPDATE property_preferences
       SET irrigation_system = true
     WHERE irrigation_system IS DISTINCT FROM true
       AND (${IRRIGATION_INPUT_PREDICATE})
  `);
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT true');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_system'))) return;
  // Data flip is not reversible (the pre-migration false is indistinguishable
  // from a deliberate one); only the default moves back.
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT false');
};

exports.__private = { IRRIGATION_INPUT_PREDICATE };
