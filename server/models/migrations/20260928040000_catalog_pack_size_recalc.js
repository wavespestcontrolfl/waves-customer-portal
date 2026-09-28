/**
 * Supersedes 20260928020000 and 20260928030000 (both frozen once pushed) for
 * the Dominion 2L / SedgeHammer 75% pack-size correction (Codex #5120 r3 +
 * pre-push audit): the catalog row, the verified vendor offers, and the
 * stored best price have to move together, through the canonical writer.
 *
 * - Dominion 2L 1 gal: the $469.53 SiteOne price is a case of 4 x 1 gal,
 *   512 oz, not 128.
 * - SedgeHammer 75%: SiteOne sells a 1.33 oz bottle, not 64 oz.
 *
 * recalcBestPrice scales the winning vendor price by vendor pack vs catalog
 * pack, so a SiteOne row still quoting the old pack (the pricing import wrote
 * it) scales $469.53-for-a-gallon up to the 512 oz case, and a 64 oz catalog
 * row scales the 1.33 oz bottle price up to ~$2,887.
 *
 * For each catalog row at the old OR the corrected size (an earlier migration
 * may already have moved it):
 *   1. the catalog pack becomes the corrected size;
 *   2. that product's SiteOne rows quoting the old pack (the offers the
 *      listings verified) take the corrected quantity and per-oz fields
 *      (approvedPerOzFields); other vendors' pack sizes are theirs and stay;
 *   3. recalcBestPrice re-ranks, re-scales, and rewrites the winner and the
 *      cached best-price fields.
 * A catalog row an administrator moved to some other size is left alone.
 * Production was corrected by hand on 2026-09-27 and carries only SiteOne
 * offers for both products, so this re-derives the same values there.
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const hasVendorPricing = await knex.schema.hasTable('vendor_pricing');
  for (const fix of FIXES) {
    const products = await knex('products_catalog')
      .where({ name: fix.name })
      .whereIn('unit_size_oz', [fix.oldOz, fix.oz])
      .select('id', 'container_size', 'unit_size_oz');
     
    const { approvedPerOzFields, recalcBestPrice } = require('../../routes/admin-inventory');
    for (const product of products) {
      if (product.container_size !== fix.container || Number(product.unit_size_oz) !== fix.oz) {
        await knex('products_catalog')
          .where({ id: product.id })
          .update({ container_size: fix.container, unit_size_oz: fix.oz, updated_at: knex.fn.now() });
      }
      if (!hasVendorPricing) continue;
      const stale = await knex('vendor_pricing')
        .join('vendors', 'vendors.id', 'vendor_pricing.vendor_id')
        .where('vendor_pricing.product_id', product.id)
        .whereRaw('lower(vendors.name) = ?', ['siteone'])
        .whereIn('vendor_pricing.quantity', fix.oldQuantities)
        .select('vendor_pricing.id', 'vendor_pricing.price');
      for (const row of stale) {
        await knex('vendor_pricing').where({ id: row.id }).update({
          quantity: fix.container,
          ...approvedPerOzFields(row.price, fix.container),
          updated_at: knex.fn.now(),
        });
      }
      // The canonical best-price writer (ranking, eligibility, pack scaling,
      // cached winner fields) — never a hand-copied price.
      await recalcBestPrice(product.id, knex);
    }
  }
};

// Data correction; the old sizes were wrong, so there is nothing to restore.
exports.down = async function down() {};
