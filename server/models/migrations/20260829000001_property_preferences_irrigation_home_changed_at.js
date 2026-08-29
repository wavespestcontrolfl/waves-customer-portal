/**
 * property_preferences.irrigation_home_changed_at — stamped by the customer
 * address fan-out when the PRIMARY home moves (street/city/zip). The weekly
 * watering plan reads the customer's sprinkler settings (zone minutes,
 * watering days, head type, typed weekly inches) as belonging to the home
 * they were saved for: settings saved BEFORE this stamp are the former
 * property's system and must not size exact controller instructions for
 * the new one (codex #3565 gh-r19). Re-saving Irrigation in the portal
 * bumps updated_at past the stamp and re-confirms them.
 *
 * Additive, hasColumn-guarded — same shape as irrigation_run_minutes.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_home_changed_at'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.timestamp('irrigation_home_changed_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (await knex.schema.hasColumn('property_preferences', 'irrigation_home_changed_at')) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.dropColumn('irrigation_home_changed_at');
    });
  }
};
