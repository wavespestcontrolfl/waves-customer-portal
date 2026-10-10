/**
 * The license requirement of the chemical area add-on services is never reset by a rollback.
 *
 * 20261008210000 marks the five chemical add-on services `requires_license = true`, category L&O, and its down() resets
 * every id it recorded. 20261010230000 took the services a visit references BY ID out of that list. But the catalog
 * rollback (20261008200000) also keeps a service that a legacy visit references only by its NAME or key (a visit with no
 * service_id), and service-closeout-requirements.js resolves that visit's requirements by name: the kept service would
 * still lose its license requirement, and that pesticide or herbicide visit could close with no check of the technician's
 * license, category or expiry.
 *
 * Both files are pushed and frozen. The rule that needs no reference logic at all: on rollback, reset NOTHING. A rollback
 * runs THIS down() first (the latest migration) and empties the recorded list, so the older down() resets no service. A
 * service the catalog rollback deletes takes its columns with it; a service it keeps stays a licensed-applicator service,
 * which is what a chemical application is. up() changes nothing.
 */
const license = require('./20261008210000_area_addon_license_category');

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: license.STATE_KEY }).first();
  if (!existing) return;
  await knex('system_settings').where({ key: license.STATE_KEY }).update({ value: JSON.stringify({ services: [] }) });
};
