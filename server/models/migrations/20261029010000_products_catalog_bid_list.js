/**
 * Bid kit "bid products" (owner 2026-10-28, "fill gaps from all missing products").
 *
 * Adds products_catalog.bid_list (boolean, NOT NULL, default false). An admin ticks it in the Inventory product editor
 * for a product the company proposes in bid work but has not applied on a customer visit in the last 12 months (for
 * example Termidor SC, named by brand in two past termite specs). The daily Bid kit Product List sync prints ticked,
 * active products in a second table under "Products proposed for bid work".
 *
 * No data change: every row starts false, so nothing prints differently until an admin ticks a product. Idempotent in
 * both directions. down() drops the column; the ticks are an owner choice that cannot be rebuilt, which is accepted for a
 * rollback of this feature.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (await knex.schema.hasColumn('products_catalog', 'bid_list')) return;
  await knex.schema.alterTable('products_catalog', (t) => {
    t.boolean('bid_list').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'bid_list'))) return;
  await knex.schema.alterTable('products_catalog', (t) => {
    t.dropColumn('bid_list');
  });
};
