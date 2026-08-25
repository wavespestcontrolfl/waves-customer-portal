/**
 * Minutes-per-zone on property preferences.
 *
 * The weekly irrigation email and the lawn report both balance rain against
 * irrigation_inches_per_week — an engineering unit customers rarely know.
 * They DO know how long each zone runs (2026-08-17: a customer replied that
 * his schedule "is in the system" — zones, days and "each zone runs 20min"
 * were all on file, but only the blank inches column is read). With minutes
 * per zone alongside the existing watering_days and irrigation_system_type,
 * @waves/irrigation-runtime can derive the inches figure; without a single
 * head type it still declines rather than guess.
 *
 * Integer minutes each zone runs on a watering day. Same additive,
 * hasColumn-guarded shape as the mowing_schedule migration.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_run_minutes'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.integer('irrigation_run_minutes');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (await knex.schema.hasColumn('property_preferences', 'irrigation_run_minutes')) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.dropColumn('irrigation_run_minutes');
    });
  }
};
