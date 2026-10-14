/**
 * Second rollback guard for 20261010120000 (area add-on protocol rows).
 *
 * 20261010140000 keeps a seeded lawn_protocol_products row whose rate, unit, product name, gates, yearly counter or
 * default_in_plan changed. The seed also writes product_id, application_mode, carrier_gal_per_1000, mixing, report_copy and
 * sort_order, and an edit of only one of those still rolled the row back (deleted). That file is pushed and frozen, so the rest
 * of the comparison lives here: a rollback runs THIS down() first (the latest migration), and it marks a seeded row with
 * role 'area_addon_kept' when one of those fields is no longer what the seed wrote. The older down() functions then leave
 * the row, its window and the protocol in place.
 *
 * product_id: the seed resolved it from the catalog by the product's name (exact, then alias) and did not record it. The row
 * counts as unchanged when its product_id is empty, or names a catalog row whose name or alias is still the seeded product.
 *
 * up() changes nothing. Any doubt (an unreadable catalog) keeps the row.
 */
const seed = require('./20261010120000_area_addon_protocol_rows');
const { KEPT_ROLE } = require('./20261010140000_area_addon_protocol_rows_rollback_guard');

const ACTION = 'area_addon_protocol_rows';
const TABLES = ['lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log'];

const asObject = (value) => {
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
};
const stable = (value) => JSON.stringify(Object.keys(asObject(value)).sort().map((key) => [key, asObject(value)[key]]));
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Are the seeded fields the first guard does not read still what 20261010120000 wrote? `productNames` are the catalog name
// and aliases of the row's product_id (null when the row has none; undefined when they could not be read).
function otherSeededFieldsUnchanged(row, addOn, productNames) {
  if (!addOn) return false;
  const productOk = row.product_id == null
    || (Array.isArray(productNames) && productNames.some((name) => normalize(name) === normalize(addOn.product)));
  return productOk
    && row.application_mode === 'area'
    && row.carrier_gal_per_1000 == null
    && stable(row.mixing) === stable({})
    && stable(row.report_copy) === stable({ role: 'area_addon', serviceKey: addOn.serviceKey })
    && Number(row.sort_order) === 1;
}

async function productNamesOf(knex, productId) {
  if (productId == null) return null;
  try {
    if (!(await knex.schema.hasTable('products_catalog'))) return undefined;
    const product = await knex('products_catalog').where({ id: productId }).first();
    const names = product ? [product.name] : [];
    if (await knex.schema.hasTable('product_aliases')) {
      for (const alias of await knex('product_aliases').where({ product_id: productId })) names.push(alias.alias_name);
    }
    return names;
  } catch {
    return undefined;
  }
}

exports.otherSeededFieldsUnchanged = otherSeededFieldsUnchanged;

exports.up = async function up() {};

exports.down = async function down(knex) {
  for (const table of TABLES) if (!(await knex.schema.hasTable(table))) return;
  const audits = await knex('lawn_protocol_audit_log').where({ action: ACTION });
  for (const audit of audits) {
    for (const id of asObject(audit.after_snapshot).products || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first();
      if (!row || row.role !== 'area_addon') continue;
      const window = await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).first('window_key');
      const addOn = seed.ADDONS.find((a) => a.serviceKey === (window && window.window_key));
      if (otherSeededFieldsUnchanged(row, addOn, await productNamesOf(knex, row.product_id))) continue;
      await knex('lawn_protocol_products').where({ id }).update({ role: KEPT_ROLE });
    }
  }
};
