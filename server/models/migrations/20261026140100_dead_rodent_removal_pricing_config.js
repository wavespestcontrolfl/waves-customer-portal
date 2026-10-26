/**
 * Dead Rodent Removal & Odor Treatment prices in pricing_config (owner approved 2026-10-26, dark behind
 * GATE_DEAD_ANIMAL_REMOVAL).
 *
 * Production pricing is DB-authoritative. This seeds the row `rodent_dead_animal_removal` (category rodent, so the Pricing
 * Logic panel lists it with the other rodent rows) with the four tier prices and the two on-site minutes the code carries
 * (constants.js RODENT.deadAnimalRemoval). db-bridge syncs it over those constants on every sync with bounds and a
 * fail-closed fallback to the code defaults (pricing-engine/dead-animal-removal-config.js: plain JSON numbers, the whole
 * row or nothing).
 *
 * The prices are FIXED numbers set from the owner's add-on cost formula, inlined here because a pushed migration is frozen
 * (a test pins them equal to constants.js):
 *   price = ((on-site min + drive min) x $35/h / 60 + material + $8 admin) / 0.40, rounded UP to a price ending in 9
 *   reachable 45 min, $12 material: alone $149 (drive 20 min + $8 admin), riding $99 (no drive, no admin)
 *   attic     90 min, $15 material: alone $219, riding $169
 * The inside-a-wall tier has no price (a custom quote) and no knob.
 *
 * Insert-if-missing: an existing row is never overwritten (an admin may already have edited it). The insert also writes one
 * pricing_config_audit row and one pricing_changelog row (tagged), so the seed has a reason in the admin history.
 * down() deletes the row only while it still holds exactly the seeded data (an operator-edited row is left alone), and only
 * the audit and changelog records this migration wrote.
 */
const { isDeepStrictEqual } = require('util');

const KEY = 'rodent_dead_animal_removal';
const TAG = 'migration:20261026140100_dead_rodent_removal_pricing_config';
const SEED = {
  reachable: { alone: 149, riding: 99, on_site_min: 45 },
  attic: { alone: 219, riding: 169, on_site_min: 90 },
};
const REASON = 'Seed the Dead Rodent Removal & Odor Treatment prices (owner approved 2026-10-26): easy reach $149 alone / $99 riding, attic search $219 alone / $169 riding; riding = the same estimate has another priced rodent one-time line (no drive, no admin). Dark behind GATE_DEAD_ANIMAL_REMOVAL.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Add Dead Rodent Removal & Odor Treatment pricing (pricing_config rodent_dead_animal_removal).',
};

const parse = (data) => {
  if (typeof data !== 'string') return data;
  try { return JSON.parse(data); } catch { return null; }
};

exports.KEY = KEY;
exports.TAG = TAG;
exports.SEED = SEED;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: KEY }).first('config_key');
  if (existing) return;
  const inserted = await knex('pricing_config').insert({
    config_key: KEY,
    name: 'Dead Rodent Removal & Odor Treatment (fixed tier prices)',
    category: 'rodent',
    sort_order: 11,
    data: JSON.stringify(SEED),
    updated_at: knex.fn.now(),
  }).onConflict('config_key').ignore().returning('config_key');
  // Another writer won the race: its row (and its history) stand.
  if (!inserted || inserted.length === 0) return;
  if (await knex.schema.hasTable('pricing_config_audit')
    && !(await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).first('id'))) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: null,
      new_value: JSON.stringify(SEED),
      changed_by: TAG,
      reason: REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['rodent_dead_animal_removal']),
      before_value: JSON.stringify(null),
      after_value: JSON.stringify({ [KEY]: SEED }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  // jsonb does not keep key order: compare the values. An edited row is the operator's and stays.
  if (!row || !isDeepStrictEqual(parse(row.data), SEED)) return;
  await knex('pricing_config').where({ config_key: KEY }).del();
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
