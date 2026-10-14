/**
 * Point each seeded area add-on protocol row at the ACTIVE catalog row of its product.
 *
 * 20261010120000 resolved product_id by exact name first, then alias. When the catalog holds an inactive legacy row under the
 * protocol's product name and an active renamed row that keeps that name as an alias, the exact-name row won and the protocol
 * row was seeded with the retired product's id. The runtime resolver (area-addon-governed-rate.js resolveProductIn) treats
 * both rows as one product and selects the active one; this brings the stored id in line. That file is pushed and frozen, so
 * the correction lives here.
 *
 * Only a seeded row (listed in the seed's audit entry, role still 'area_addon', product_name still the seeded name) whose
 * product_id is empty or names an INACTIVE catalog row is changed, and only when exactly the product's name-or-alias set
 * holds an active row. Idempotent. down() changes nothing: the id it would restore is a retired product's.
 */
const seed = require('./20261010120000_area_addon_protocol_rows');

const ACTION = 'area_addon_protocol_rows';
const TABLES = ['lawn_protocol_windows', 'lawn_protocol_products', 'lawn_protocol_audit_log', 'products_catalog'];

const asObject = (value) => {
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === 'object' ? value : {};
};
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The active catalog row of the product named `name`: a row whose own name or one of whose aliases is that name.
function activeProductId(name, catalog, aliases) {
  const wanted = normalize(name);
  const aliased = new Set(aliases.filter((row) => normalize(row.alias_name) === wanted).map((row) => String(row.product_id)));
  const same = catalog.filter((row) => normalize(row.name) === wanted || aliased.has(String(row.id)));
  const live = same.filter((row) => row.active !== false);
  return live.length ? live[0].id : null;
}

exports.activeProductId = activeProductId;

exports.up = async function up(knex) {
  for (const table of TABLES) if (!(await knex.schema.hasTable(table))) return;
  const catalog = await knex('products_catalog').select('id', 'name', 'active');
  const aliases = (await knex.schema.hasTable('product_aliases')) ? await knex('product_aliases').select('product_id', 'alias_name') : [];
  const activeIds = new Set(catalog.filter((row) => row.active !== false).map((row) => String(row.id)));
  const audits = await knex('lawn_protocol_audit_log').where({ action: ACTION });
  for (const audit of audits) {
    for (const id of asObject(audit.after_snapshot).products || []) {
      const row = await knex('lawn_protocol_products').where({ id }).first();
      if (!row || row.role !== 'area_addon') continue;
      if (row.product_id != null && activeIds.has(String(row.product_id))) continue;
      const window = await knex('lawn_protocol_windows').where({ id: row.lawn_protocol_window_id }).first('window_key');
      const addOn = seed.ADDONS.find((a) => a.serviceKey === (window && window.window_key));
      if (!addOn || row.product_name !== addOn.product) continue;
      const active = activeProductId(addOn.product, catalog, aliases);
      if (active == null || String(active) === String(row.product_id)) continue;
      await knex('lawn_protocol_products').where({ id }).update({ product_id: active });
    }
  }
};

exports.down = async function down() {};
