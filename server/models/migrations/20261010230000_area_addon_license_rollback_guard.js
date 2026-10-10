/**
 * Rollback guard for 20261008210000 (area add-on license category).
 *
 * That migration marks the five chemical add-on services `requires_license = true`, category L&O, and records the ids it
 * changed in system_settings. Its down() resets every recorded id. But the catalog migration's down() (20261008200000 with
 * its guard 20261010160000) KEEPS a service a visit references, so that the visit can still complete; after a rollback such
 * a kept pesticide or herbicide service would close with no check of the technician's license, category or expiry
 * (service-closeout-requirements.js reads these columns).
 *
 * That file is pushed and frozen, so the guard lives here: a rollback runs THIS down() first (the latest migration), and it
 * takes out of the recorded list every service a visit or an add-on row still references. The older down() then resets
 * only the services nothing uses, and the license requirement stays on the ones that remain bookable work.
 *
 * up() changes nothing. Any failed reference read keeps the id out of the reset list (the requirement stays).
 */
const license = require('./20261008210000_area_addon_license_category');

async function referenced(knex, serviceId) {
  try {
    if (await knex.schema.hasTable('scheduled_services')
      && await knex('scheduled_services').where({ service_id: serviceId }).first('id')) return true;
    if (await knex.schema.hasTable('scheduled_service_addons')
      && await knex('scheduled_service_addons').where({ service_id: serviceId }).first('id')) return true;
    return false;
  } catch {
    return true;
  }
}

exports.referenced = referenced;

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: license.STATE_KEY }).first();
  if (!existing) return;
  let ids = [];
  try { ids = JSON.parse(existing.value).services || []; } catch { return; }
  const resettable = [];
  for (const id of ids) if (!(await referenced(knex, id))) resettable.push(id);
  if (resettable.length === ids.length) return;
  await knex('system_settings').where({ key: license.STATE_KEY }).update({ value: JSON.stringify({ services: resettable }) });
};
