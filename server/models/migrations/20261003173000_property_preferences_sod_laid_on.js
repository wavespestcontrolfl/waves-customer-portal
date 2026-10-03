/**
 * property_preferences.sod_laid_on — the calendar day new sod went down at the
 * property (lawn report rebuild P35, GATE_LAWN_NEW_SOD_MODE). Set and cleared
 * by the office in Customer 360 (Access & Preferences). While the lawn report's
 * visit falls inside the new-sod window the report replaces its watering
 * banner, week plan and expectation lines with fixed new-sod sentences.
 *
 * Waves does not install sod; this records sod someone else laid.
 *
 * Additive, nullable, no default, no backfill, hasColumn-guarded. A plain
 * `date` (not a timestamp): the day is a calendar fact read in America/New_York,
 * so there is no timezone to leak.
 */
const COLUMN = 'sod_laid_on';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (await knex.schema.hasColumn('property_preferences', COLUMN)) return;
  await knex.schema.alterTable('property_preferences', (t) => {
    t.date(COLUMN).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', COLUMN))) return;
  await knex.schema.alterTable('property_preferences', (t) => {
    t.dropColumn(COLUMN);
  });
};
