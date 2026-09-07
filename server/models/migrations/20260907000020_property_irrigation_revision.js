// Preserve evidence of irrigation edits even when a value is later restored.
// A database trigger covers every writer, including confirmations and address
// fan-out, without treating unrelated property updates as irrigation edits.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_revision'))) {
    await knex.schema.alterTable('property_preferences', (table) => {
      table.bigInteger('irrigation_revision').notNullable().defaultTo(0);
    });
  }
  await knex.raw(`
    CREATE OR REPLACE FUNCTION bump_property_irrigation_revision()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.irrigation_revision := OLD.irrigation_revision;
      IF ROW(NEW.irrigation_system, NEW.irrigation_controller_location,
             NEW.irrigation_zones, NEW.irrigation_inches_per_week,
             NEW.irrigation_run_minutes, NEW.irrigation_schedule_notes,
             NEW.watering_days, NEW.irrigation_system_type, NEW.rain_sensor,
             NEW.irrigation_issues, NEW.irrigation_confirmed_fields,
             NEW.irrigation_home_changed_at)
         IS DISTINCT FROM
         ROW(OLD.irrigation_system, OLD.irrigation_controller_location,
             OLD.irrigation_zones, OLD.irrigation_inches_per_week,
             OLD.irrigation_run_minutes, OLD.irrigation_schedule_notes,
             OLD.watering_days, OLD.irrigation_system_type, OLD.rain_sensor,
             OLD.irrigation_issues, OLD.irrigation_confirmed_fields,
             OLD.irrigation_home_changed_at) THEN
        NEW.irrigation_revision := OLD.irrigation_revision + 1;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS property_irrigation_revision ON property_preferences;
    CREATE TRIGGER property_irrigation_revision
      BEFORE UPDATE ON property_preferences
      FOR EACH ROW EXECUTE FUNCTION bump_property_irrigation_revision();
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  await knex.raw('DROP TRIGGER IF EXISTS property_irrigation_revision ON property_preferences');
  await knex.raw('DROP FUNCTION IF EXISTS bump_property_irrigation_revision()');
  if (await knex.schema.hasColumn('property_preferences', 'irrigation_revision')) {
    await knex.schema.alterTable('property_preferences', (table) => {
      table.dropColumn('irrigation_revision');
    });
  }
};
