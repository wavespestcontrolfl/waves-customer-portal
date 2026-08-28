/**
 * Irrigation ON by default (owner ruling 2026-08-27).
 *
 * The portal's "Irrigation system" toggle is retired; the portal presents
 * every property as irrigated and stamps irrigation_system = true on any
 * irrigation write. The lawn report and the Monday irrigation email still
 * read the column and suppress a DERIVED weekly-inches figure when it is
 * false, so rows the old toggle's false DEFAULT left behind while the
 * customer had already entered runtime inputs (minutes, days, head type,
 * explicit inches, zones…) would keep hiding a figure the customer actually
 * supplied. Flip exactly those rows — a customer who entered a watering
 * schedule has a system.
 *
 * Rows with NO irrigation inputs are left alone: a false there may be a
 * deliberate "no system" set through the old toggle, which is
 * indistinguishable from the default and must not be rewritten (pre-push
 * codex P0). Those rows have nothing to derive anyway; the route stamps true
 * on their next irrigation write, and the weekly email's system-off ask no
 * longer points at the retired toggle.
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
  OR NULLIF(BTRIM(irrigation_issues), '') IS NOT NULL
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
  // The data flip is not reversible (the pre-migration false is
  // indistinguishable from a deliberate one); only the default moves back.
  await knex.raw('ALTER TABLE property_preferences ALTER COLUMN irrigation_system SET DEFAULT false');
};

exports.__private = { IRRIGATION_INPUT_PREDICATE };
