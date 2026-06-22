/**
 * Add small wall-job pricing levers to the Bora-Care config.
 *
 * Bora-Care pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_boracare` over the in-code constants, so the
 * constants.js defaults added in this PR would be inert for these keys in any
 * env that grows the row. This migration seeds the two new keys so the engine
 * (and any future admin edit) uses them:
 *
 *   - min_job_price (150): floor for a wall-spray (linear-ft) Bora-Care job so
 *     a tiny job still covers the truck roll.
 *   - wall_labor_sqft_per_hr (320): labor productivity for wall spraying, used
 *     in place of the attic 1.5h-base / 2h-floor curve on wall-only jobs.
 *
 * Owner decision 2026-06-22: a 20 LF × 8 ft (160 sqft, ~30 min) wall job was
 * pricing at $808 because it inherited the attic 3-gallon / 2-hour floors; it
 * should land ~$282, floored at $150.
 *
 * Read-modify-write so admin edits to gal_cost/coverage_sqft/equip_cost in the
 * same row survive.
 */
const CONFIG_KEY = 'onetime_boracare';
const MIGRATION_TAG = 'migration:20260622000011';
const MIN_JOB_PRICE = 150;
const WALL_LABOR_SQFT_PER_HR = 320;
const UP_REASON = 'Add wall-spray small-job pricing (min_job_price, wall_labor_sqft_per_hr) — owner decision 2026-06-22';
const DOWN_REASON = 'Revert wall-spray small-job pricing keys';

async function loadRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: CONFIG_KEY }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function save(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: CONFIG_KEY })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: CONFIG_KEY,
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  // Leave any prior admin-set values alone.
  if (data.min_job_price !== undefined && data.wall_labor_sqft_per_hr !== undefined) return;
  const newData = {
    ...data,
    min_job_price: data.min_job_price ?? MIN_JOB_PRICE,
    wall_labor_sqft_per_hr: data.wall_labor_sqft_per_hr ?? WALL_LABOR_SQFT_PER_HR,
  };
  await save(knex, data, newData, UP_REASON);
};

exports.down = async function (knex) {
  const loaded = await loadRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  const newData = { ...data };
  delete newData.min_job_price;
  delete newData.wall_labor_sqft_per_hr;
  await save(knex, data, newData, DOWN_REASON);
};
