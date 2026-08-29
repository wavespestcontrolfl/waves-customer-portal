/**
 * property_preferences.irrigation_home_changed_at — stamped by the customer
 * address fan-out when the PRIMARY home moves (street/city/zip). The weekly
 * watering plan reads the customer's sprinkler settings (zone minutes,
 * watering days, head type, typed weekly inches) as belonging to the home
 * they were saved for: settings saved BEFORE this stamp are the former
 * property's system and must not size exact controller instructions for
 * the new one (codex #3565 gh-r19). Re-confirmation is tracked PER
 * instruction-shaping field: irrigation_confirmed_fields (jsonb array) is
 * reset by the move and gains a field each time the portal saves it (the
 * portal autosaves one field per PUT), so the plan trusts the settings only
 * once every non-null sizing field — zone minutes, watering days, head
 * type, typed weekly inches — has been re-saved for the new home. Neither
 * the row-wide updated_at nor a non-sizing irrigation edit (controller
 * location, notes) confirms anything (codex gh-r20/r21).
 *
 * Additive, hasColumn-guarded — same shape as irrigation_run_minutes.
 */
const COLUMNS = ['irrigation_home_changed_at', 'irrigation_confirmed_fields'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_home_changed_at'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.timestamp('irrigation_home_changed_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_confirmed_fields'))) {
    await knex.schema.alterTable('property_preferences', (t) => {
      t.jsonb('irrigation_confirmed_fields').notNullable().defaultTo('[]');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn('property_preferences', col)) {
      await knex.schema.alterTable('property_preferences', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
