/**
 * Area add-on catalog rows read "not taxable" in the Service Library.
 *
 * Owner rule 2026-10-08 (20261008141000, #6159): lawn care and every
 * residential service is non-taxable, and services.is_taxable is a Service
 * Library DISPLAY field only (invoice tax comes from service_taxability and
 * the customer's property type). 20261008200000 inserted the six add-on rows
 * with is_taxable true before that rule landed, so they would read "Taxable"
 * while their residential invoices carry no tax.
 *
 * Sets is_taxable false on the six rows that are still true. No invoice,
 * estimate or tax rate changes: the service_taxability rows (residential not
 * taxed, commercial taxed) are untouched. up() records the ids it changed in a
 * system_settings state row; down() restores only those, and only while they
 * are still false.
 */

const SERVICE_KEYS = [
  'area_addon_bed_pre_emergent',
  'area_addon_lawn_insect_spot',
  'area_addon_fire_ant_yard',
  'area_addon_lawn_insect_preventive',
  'area_addon_hardscape_weed',
  'area_addon_web_sweep',
];
const STATE_KEY = 'migration.20261008240000.state';

exports.SERVICE_KEYS = SERVICE_KEYS;
exports.STATE_KEY = STATE_KEY;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const changed = [];
  for (const serviceKey of SERVICE_KEYS) {
    const row = await knex('services').where({ service_key: serviceKey }).first();
    if (!row || row.is_taxable !== true) continue;
    await knex('services').where({ id: row.id }).update({ is_taxable: false });
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
    if (!row || row.is_taxable !== false) continue;
    await knex('services').where({ id }).update({ is_taxable: true });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};
