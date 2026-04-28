/**
 * Termite bait install pricing — Apr 2026 competitive review.
 *
 * Drops install multiplier 1.75 → 1.45 and updates per-station material
 * costs to verified wholesale (Advance TBS RFID $13.16/sta from
 * $131.60/10-cs case; Trelona ATBS RFID $22.05/sta from $352.80/16-cs).
 * Default system in service-pricing.js / property-lookup-v2.js / the
 * estimate orchestrator switched to 'advance' in the same change.
 *
 * Trigger: All U Need Pest Control invoice (21 Sentricon stations,
 * $375 total) in the Manatee market — prior 1.75x multiplier with a
 * Trelona default put our doorstep ~3x competitor. New scenario:
 * 21-sta Advance install lands ~$609, retains ~38% margin.
 *
 * The pricing_config table has two coexisting termite_install schemas:
 *   - short-key (admin-pricing-config.js):
 *       multiplier, advance_bait, trelona_bait, labor_per_station,
 *       misc_per_station, hexpro_bait
 *   - long-key (20260414000026_pricing_config_jsonb.js):
 *       install_multiplier, advance_station_cost, trelona_station_cost,
 *       labor_material_per_station, misc_per_station,
 *       station_spacing_ft, min_stations
 *
 * db-bridge.js reads only the short-key form, so production behavior
 * is governed by those keys. We update both shapes via JSONB || merge
 * so any environment converges to the new values regardless of which
 * seeder populated it.
 *
 * down() restores the prior values for rollback parity.
 */

const NEW_VALUES = {
  multiplier: 1.45,
  advance_bait: 13.16,
  trelona_bait: 22.05,
  install_multiplier: 1.45,
  advance_station_cost: 13.16,
  trelona_station_cost: 22.05,
};

const OLD_VALUES = {
  multiplier: 1.75,
  advance_bait: 14,
  trelona_bait: 24,
  install_multiplier: 1.75,
  advance_station_cost: 14,
  trelona_station_cost: 24,
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) {
    return;
  }
  const result = await knex('pricing_config')
    .where({ config_key: 'termite_install' })
    .update({
      data: knex.raw('data || ?::jsonb', [JSON.stringify(NEW_VALUES)]),
      updated_at: knex.fn.now(),
    });
  // eslint-disable-next-line no-console
  console.log(`[termite_install_pricing_april_2026] updated ${result} row(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) {
    return;
  }
  await knex('pricing_config')
    .where({ config_key: 'termite_install' })
    .update({
      data: knex.raw('data || ?::jsonb', [JSON.stringify(OLD_VALUES)]),
      updated_at: knex.fn.now(),
    });
};
