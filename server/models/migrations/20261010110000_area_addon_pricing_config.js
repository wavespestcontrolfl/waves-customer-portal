/**
 * Area add-on prices in pricing_config (Codex round 9 on #6135).
 *
 * Production pricing is DB-authoritative, but the add-on table (target margin, admin charge per job, and per add-on the
 * material cost, setup minutes, minutes per 1,000 sq ft and area tiers) lived only in constants.js. This seeds the row
 * `area_addon_pricing` (category one_time, so the Pricing Logic panel lists it on its One-time tab and edits it through the
 * generic row editor) with the values the code carries today. db-bridge syncs it over AREA_ADDONS on every sync with
 * bounds and a fail-closed fallback to the code defaults (pricing-engine/area-addon-config.js).
 *
 * Label-bound fields stay in code and are not in the row: maxPerYear, minDaysApart, requiresGrassTrack, limitProduct,
 * the service keys and names.
 *
 * Insert-if-missing: an existing row is never overwritten (an admin may already have edited it). down() deletes the row
 * only while it still holds exactly the seeded data; an edited row is left alone.
 */
const { isDeepStrictEqual } = require('util');

const KEY = 'area_addon_pricing';
const SEED = {
  targetMargin: 0.6,
  adminPerJob: 8,
  items: {
    bed_pre_emergent: { materialPer1000: 10.32, setupMin: 6, minPer1000: 8, tiers: [1000, 2000, 3500] },
    lawn_insect_spot: { materialPer1000: 1.45, setupMin: 8, minPer1000: 6, tiers: [1000, 2000, 3500] },
    fire_ant_yard: { materialPer1000: 3.66, setupMin: 6, minPer1000: 2.5, tiers: [3000, 5000, 8000] },
    lawn_insect_preventive: { materialPer1000: 2.6, setupMin: 8, minPer1000: 2.5, tiers: [3000, 5000, 8000] },
    hardscape_weed: { materialPer1000: 18.48, setupMin: 8, minPer1000: 6, tiers: [1000, 2000, 3500] },
    web_sweep: { materialPer1000: 0, setupMin: 25, minPer1000: 0 },
  },
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};

exports.SEED = SEED;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: KEY }).first('config_key');
  if (existing) return;
  await knex('pricing_config').insert({
    config_key: KEY,
    name: 'Area Add-On Treatment Pricing',
    category: 'one_time',
    sort_order: 40,
    data: JSON.stringify(SEED),
    updated_at: knex.fn.now(),
  }).onConflict('config_key').ignore();
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  // jsonb does not keep key order: compare the values.
  if (!row || !isDeepStrictEqual(parse(row.data), SEED)) return;
  await knex('pricing_config').where({ config_key: KEY }).del();
};
