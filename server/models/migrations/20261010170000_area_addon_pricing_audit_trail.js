/**
 * Audit trail for the area add-on pricing row (pricing_config `area_addon_pricing`).
 *
 * 20261010110000 seeded the row with no pricing_config_audit or pricing_changelog
 * record, so the prices would become active with no reason or change identity in
 * the admin history. That file is pushed and frozen, so the records are written
 * here: one audit row (old value empty, new value the seed) and one changelog
 * entry, both carrying this migration's tag.
 *
 * Written only while the row still holds the seed (an operator edit made since
 * has its own audit row from the Pricing Logic panel) and only once. down()
 * removes exactly the records with this migration's tag; the row itself is
 * 20261010110000's to remove.
 */
const { isDeepStrictEqual } = require('util');
const seed = require('./20261010110000_area_addon_pricing_config');

const KEY = 'area_addon_pricing';
const TAG = 'migration:20261010170000_area_addon_pricing_audit_trail';
const REASON = 'Seed the area add-on treatment pricing (owner rulings 2026-10-08): 60% target margin, $8 admin per job, and per add-on the material cost per 1,000 sq ft, setup minutes, minutes per 1,000 sq ft and area tiers. Dark behind GATE_AREA_ADDONS.';
const CHANGELOG = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: TAG,
  category: 'rule',
  summary: 'Add area add-on treatment pricing (pricing_config area_addon_pricing).',
};

const parse = (data) => {
  if (typeof data === 'string') { try { return JSON.parse(data); } catch { return null; } }
  return data;
};

exports.KEY = KEY;
exports.TAG = TAG;
exports.CHANGELOG = CHANGELOG;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: KEY }).first('data');
  if (!row || !isDeepStrictEqual(parse(row.data), seed.SEED)) return;
  if (await knex.schema.hasTable('pricing_config_audit')
    && !(await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).first('id'))) {
    await knex('pricing_config_audit').insert({
      config_key: KEY,
      old_value: null,
      new_value: JSON.stringify(seed.SEED),
      changed_by: TAG,
      reason: REASON,
    });
  }
  if (await knex.schema.hasTable('pricing_changelog')
    && !(await knex('pricing_changelog').where(CHANGELOG).first('id'))) {
    await knex('pricing_changelog').insert({
      ...CHANGELOG,
      affected_services: JSON.stringify(['area_addon']),
      before_value: JSON.stringify(null),
      after_value: JSON.stringify({ [KEY]: seed.SEED }),
      rationale: REASON,
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').where({ config_key: KEY, changed_by: TAG }).del();
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG).del();
  }
};
