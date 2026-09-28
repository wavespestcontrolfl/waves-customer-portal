/**
 * Supersedes the pack-size half of 20260928020000 (frozen once pushed):
 * the catalog row, its vendor rows, and the stored best price have to move
 * together (Codex #5120 r3).
 *
 * - Dominion 2L 1 gal: the $469.53 SiteOne price is a case of 4 x 1 gal,
 *   512 oz, not 128.
 * - SedgeHammer 75%: SiteOne sells a 1.33 oz bottle, not 64 oz.
 *
 * recalcBestPrice scales the winning vendor price by vendor pack vs catalog
 * pack, so a vendor row still quoting the old pack (the pricing import wrote
 * it) would scale $469.53-for-a-gallon up to the 512 oz case, and a 64 oz
 * catalog row scales the 1.33 oz bottle price up to ~$2,887.
 *
 * For each catalog row at the old OR the corrected size (20260928020000 may
 * already have moved it):
 *   1. the catalog pack becomes the corrected size;
 *   2. that product's vendor rows quoting the old pack take the corrected
 *      quantity and per-oz figures;
 *   3. when the winning vendor row now quotes the corrected pack, the best
 *      price becomes that row's own price (same pack, no scaling).
 * A catalog row an administrator moved to some other size is left alone.
 * Production was corrected by hand on 2026-09-27, so this writes nothing
 * there.
 */
const FIXES = [
  {
    name: 'Dominion 2L 1 gal',
    oldOz: 128,
    oldQuantities: ['1 gal'],
    container: '4 x 1 gal case',
    oz: 512,
  },
  {
    name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    oldOz: 64,
    oldQuantities: ['64 oz'],
    container: '1.33 oz',
    oz: 1.33,
  },
];

const perOzFor = (price, oz) => {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? Math.round((n / oz) * 10000) / 10000 : null;
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const hasVendorPricing = await knex.schema.hasTable('vendor_pricing');
  for (const fix of FIXES) {
    const products = await knex('products_catalog')
      .where({ name: fix.name })
      .whereIn('unit_size_oz', [fix.oldOz, fix.oz])
      .select('id', 'container_size', 'unit_size_oz', 'best_price', 'best_vendor_pricing_id');
    for (const product of products) {
      if (product.container_size !== fix.container || Number(product.unit_size_oz) !== fix.oz) {
        await knex('products_catalog')
          .where({ id: product.id })
          .update({ container_size: fix.container, unit_size_oz: fix.oz, updated_at: knex.fn.now() });
      }
      if (!hasVendorPricing) continue;
      const stale = await knex('vendor_pricing')
        .where({ product_id: product.id })
        .whereIn('quantity', fix.oldQuantities)
        .select('id', 'price');
      for (const row of stale) {
        const perOz = perOzFor(row.price, fix.oz);
        await knex('vendor_pricing').where({ id: row.id }).update({
          quantity: fix.container,
          price_per_oz: perOz,
          normalized_unit_price: perOz,
          unit_normalized: perOz != null ? 'oz' : null,
          updated_at: knex.fn.now(),
        });
      }
      if (!product.best_vendor_pricing_id) continue;
      const winner = await knex('vendor_pricing')
        .where({ id: product.best_vendor_pricing_id, quantity: fix.container })
        .first('price');
      if (winner && Number(winner.price) > 0 && Number(winner.price) !== Number(product.best_price)) {
        await knex('products_catalog').where({ id: product.id }).update({
          best_price: winner.price,
          best_price_amount_cached: winner.price,
          updated_at: knex.fn.now(),
        });
      }
    }
  }
};

// Data correction; the old sizes were wrong, so there is nothing to restore.
exports.down = async function down() {};
