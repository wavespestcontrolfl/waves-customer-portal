/**
 * Area add-on catalog rows: the five chemical add-ons need a licensed
 * applicator. 20261008200000 inserted all six rows with requires_license
 * false, so completion froze "no license required" and closeout-status never
 * checked the technician's license, expiry or category for a pesticide or
 * herbicide application. This sets requires_license true and license_category
 * 'L&O' (the lawn and ornamental category the sibling lawn treatment rows
 * carry) on the five chemical rows. The web sweep is labor only and keeps
 * requires_license false.
 *
 * Only a row still in the exact state 20261008200000 wrote (requires_license
 * false, no license_category) is changed, so an operator edit is never
 * overwritten. up() records the ids it changed in a system_settings state
 * row; down() restores only those, and only while they still hold the values
 * this migration wrote.
 */

const CHEMICAL_SERVICE_KEYS = [
  'area_addon_bed_pre_emergent',
  'area_addon_lawn_insect_spot',
  'area_addon_fire_ant_yard',
  'area_addon_lawn_insect_preventive',
  'area_addon_hardscape_weed',
];
const LICENSE_CATEGORY = 'L&O';
const STATE_KEY = 'migration.20261008210000.state';

exports.CHEMICAL_SERVICE_KEYS = CHEMICAL_SERVICE_KEYS;
exports.LICENSE_CATEGORY = LICENSE_CATEGORY;
exports.STATE_KEY = STATE_KEY;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[area-addon-license] services table absent - skipping');
    return;
  }
  const changed = [];
  for (const serviceKey of CHEMICAL_SERVICE_KEYS) {
    const row = await knex('services').where({ service_key: serviceKey }).first();
    if (!row) continue;
    if (row.requires_license !== false || row.license_category) {
      console.warn(`[area-addon-license] ${serviceKey}: license fields already set - leaving untouched`);
      continue;
    }
    await knex('services').where({ id: row.id }).update({ requires_license: true, license_category: LICENSE_CATEGORY });
    changed.push(row.id);
  }
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  let prior = [];
  try { prior = existing ? JSON.parse(existing.value).services || [] : []; } catch { /* keep empty */ }
  const value = JSON.stringify({ services: [...new Set([...prior, ...changed])] });
  if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  else await knex('system_settings').insert({ key: STATE_KEY, value });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!existing) return;
  let ids = [];
  try { ids = JSON.parse(existing.value).services || []; } catch { /* nothing recorded */ }
  for (const id of ids) {
    const row = await knex('services').where({ id }).first();
    if (!row || row.requires_license !== true || row.license_category !== LICENSE_CATEGORY) continue;
    await knex('services').where({ id }).update({ requires_license: false, license_category: null });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
