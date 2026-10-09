/**
 * Marks the bermuda removal product_limits rows (migration 20261006190100) with a
 * program tag, so application-limits.js can treat them as that program's rows:
 * inert while GATE_LAWN_BERMUDA_REMOVAL is off, and counting history for the treated
 * property alone. 190100 is pushed and frozen, so the tag is a new migration.
 *
 * The tag is match_value = 'bermuda_removal' on the rows' own 'product' match type:
 * match_value is documented as the moa_group or category value for those match
 * types and is unused on a product row, so no column is added. The rows are found
 * by what 190100 wrote: match_type 'product', the Recognition or Fusilade II catalog
 * id, and the owner-dated description. Idempotent; down() clears exactly the tag
 * this migration set.
 */
const PROGRAM = 'bermuda_removal';
const DESCRIPTION_TAG = 'bermuda removal (owner 2026-10-06)';
const NAMES = ['Recognition Post Emergent Herbicide', 'Fusilade II Post Emergent Liquid Herbicide'];
const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function bermudaProductIds(knex) {
  const wanted = new Set(NAMES.map(normalize));
  return (await knex('products_catalog').select('id', 'name')).filter((row) => wanted.has(normalize(row.name))).map((row) => row.id);
}

const bermudaRows = (knex, ids) => knex('product_limits').whereIn('product_id', ids)
  .where({ match_type: 'product' }).where('description', 'like', `%${DESCRIPTION_TAG}%`);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const ids = await bermudaProductIds(knex);
  if (ids.length) await bermudaRows(knex, ids).whereNull('match_value').update({ match_value: PROGRAM });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_limits')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const ids = await bermudaProductIds(knex);
  if (ids.length) await bermudaRows(knex, ids).where({ match_value: PROGRAM }).update({ match_value: null });
};
