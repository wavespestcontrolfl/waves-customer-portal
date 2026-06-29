/**
 * Seed the Velista (penthiopyrad, FRAC 7) fungicide into products_catalog.
 *
 * Velista was added to the Zoysia December large-patch slot (PR #2205) to break
 * the FRAC-3 rotation overlap, but it had no catalog row — so the plan builder
 * (waveguard-plan-engine.js, which resolves protocol text against products_catalog)
 * and the material-cost audit couldn't price/rate it. This adds the real
 * inventory row: Syngenta Velista 22 oz @ $297.00 ($13.50/oz), label rate
 * 0.5 oz/1,000 sq ft. Idempotent — upserts by name.
 */

const PRODUCT = {
  name: 'Velista',
  category: 'Fungicide',
  active: true,
  active_ingredient: 'Penthiopyrad',
  formulation: 'WDG',
  frac_group: '7',
  analysis_n: 0,
  analysis_p: 0,
  analysis_k: 0,
  default_rate_per_1000: 0.5,
  rate_unit: 'oz',
  best_price: 297.0,
  cost_per_unit: 13.5,
  cost_unit: 'oz',
  container_size: '22 oz',
  unit_size_oz: 22,
  inventory_unit: 'oz',
  needs_pricing: false,
  customer_visibility: 'internal_only',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const existing = await knex('products_catalog').where({ name: PRODUCT.name }).first();
  let productId;
  if (existing) {
    await knex('products_catalog')
      .where({ id: existing.id })
      .update({ ...PRODUCT, updated_at: knex.fn.now() });
    productId = existing.id;
  } else {
    const [row] = await knex('products_catalog')
      .insert({
        ...PRODUCT,
        content_status: 'active',
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning('id');
    productId = row && (row.id || row);
  }

  // Alias so the protocol text "Velista" and any "Velista SC/WDG" variants resolve.
  if (productId && (await knex.schema.hasTable('product_aliases'))) {
    for (const aliasName of ['Velista SC', 'Velista WDG']) {
      const exists = await knex('product_aliases').where({ alias_name: aliasName }).first().catch(() => null);
      if (!exists) {
        await knex('product_aliases')
          .insert({
            product_id: productId,
            alias_name: aliasName,
            vendor_id: null,
            created_at: knex.fn.now(),
            updated_at: knex.fn.now(),
          })
          .catch(() => {});
      }
    }
  }
};

exports.down = async function down(knex) {
  // Non-destructive: leave the catalog row in place (it may have accrued
  // inventory/movement history). Only drop the aliases this migration added.
  if (await knex.schema.hasTable('product_aliases')) {
    await knex('product_aliases').whereIn('alias_name', ['Velista SC', 'Velista WDG']).del().catch(() => {});
  }
};
