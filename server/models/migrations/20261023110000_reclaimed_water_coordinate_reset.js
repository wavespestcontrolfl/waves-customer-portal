/**
 * Reclaimed water: a county verdict never outlives the coordinates it was judged on (GATE_LAWN_RECLAIMED_HALF_N, Codex r1 on #6511).
 *
 * 20261023100000 (frozen) added customer_properties.reclaimed_water / _source / _checked_at. The county job judges a property by its
 * coordinates, and many writers invalidate or replace them (the geocode review's clearLocationMirrors, a re-geocode, a manual pin,
 * syncPrimaryAddress, syncPrimaryCoordsFromCustomer, the lookup enrichers). One BEFORE UPDATE trigger on the coordinate columns is the
 * single chokepoint that covers all of them, including ones added later: when latitude or longitude changes on a row whose answer is still the
 * county's (a 'county_meter' verdict, or the "outside the layer" result: no source, checked_at stamped), and the same statement did not write a fresh verdict, the three reclaimed columns are cleared, so the next county
 * tick judges the new location. An 'office' or 'customer' answer is never touched here (a person said it about the home, not about a pin).
 *
 * The trigger has no gate: it only ever clears a county value, which is stale the moment its coordinates change. It never touches updated_at.
 *
 * Idempotent in both directions. down() drops the trigger and the function.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'reclaimed_water_source'))) return;
  await knex.raw(`
    CREATE OR REPLACE FUNCTION reset_county_reclaimed_water_on_coordinate_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude THEN
        -- The county's answer: a verdict ('county_meter') or "no opinion" (outside the layer: source NULL, but checked_at stamped). Either was
        -- judged on the old coordinates. Not when the same statement wrote a fresh answer.
        IF NEW.reclaimed_water_source IS NOT DISTINCT FROM OLD.reclaimed_water_source
           AND NEW.reclaimed_water IS NOT DISTINCT FROM OLD.reclaimed_water
           AND NEW.reclaimed_water_checked_at IS NOT DISTINCT FROM OLD.reclaimed_water_checked_at
           AND (NEW.reclaimed_water_source = 'county_meter' OR (NEW.reclaimed_water_source IS NULL AND NEW.reclaimed_water_checked_at IS NOT NULL)) THEN
          NEW.reclaimed_water := NULL;
          NEW.reclaimed_water_source := NULL;
          NEW.reclaimed_water_checked_at := NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS customer_properties_reclaimed_coordinate_reset ON customer_properties;
    CREATE TRIGGER customer_properties_reclaimed_coordinate_reset
      BEFORE UPDATE OF latitude, longitude ON customer_properties
      FOR EACH ROW EXECUTE FUNCTION reset_county_reclaimed_water_on_coordinate_change();
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customer_properties')) {
    await knex.raw('DROP TRIGGER IF EXISTS customer_properties_reclaimed_coordinate_reset ON customer_properties');
  }
  await knex.raw('DROP FUNCTION IF EXISTS reset_county_reclaimed_water_on_coordinate_change()');
};
