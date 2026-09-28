/**
 * Catalog pack-size corrections (owner-approved 2026-09-27, SiteOne listings).
 *
 * - Dominion 2L 1 gal: the $469.53 SiteOne price is a case of 4 x 1 gal
 *   (the FL gallon is sold by the case), 512 oz, not 128.
 * - SedgeHammer 75%: SiteOne sells a 1.33 oz bottle, not 64 oz.
 *
 * server/data/pricing.csv carries the same corrections, but the admin pricing
 * import only fills container_size / unit_size_oz when they are empty, and
 * recalcBestPrice scales the winning vendor price by vendor pack vs catalog
 * pack — so the catalog row, the SiteOne offers, and the stored best price
 * have to move together. A SiteOne row still quoting '1 gal' scales $469.53
 * up to the 512 oz case; a 64 oz catalog row scales the 1.33 oz bottle price
 * up to ~$2,887.
 *
 * For each catalog row at the old or the corrected size:
 *   1. the catalog pack becomes the corrected size;
 *   2. its SiteOne rows at the old or corrected pack (the offers the listings
 *      verified) take the corrected quantity and re-derived per-oz fields;
 *      price_amount re-syncs to price and landed cost built on the old pack
 *      is cleared. Eligibility (approval_status, is_active, expires_at) is
 *      the reviewer's and is never touched; other vendors' packs stay theirs;
 *   3. recalcBestPrice re-ranks, re-scales, and rewrites the winner and the
 *      cached best-price fields.
 * A catalog row an administrator moved to some other size is left alone.
 * Production was corrected by hand on 2026-09-27, so this re-derives the
 * same values there.
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

const packFields = (price, oz) => {
  const n = Number(price);
  const perOz = Number.isFinite(n) && n > 0 ? Math.round((n / oz) * 10000) / 10000 : null;
  return {
    unit_normalized: perOz != null ? 'oz' : null,
    price_per_oz: perOz,
    normalized_unit_price: perOz,
    price_amount: Number.isFinite(n) ? n : null,
    landed_unit_price: null,
    landed_cost: null,
  };
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const hasVendorPricing = await knex.schema.hasTable('vendor_pricing');
  for (const fix of FIXES) {
    const products = await knex('products_catalog')
      .where({ name: fix.name })
      .whereIn('unit_size_oz', [fix.oldOz, fix.oz])
      .select('id', 'container_size', 'unit_size_oz');
    for (const product of products) {
      if (product.container_size !== fix.container || Number(product.unit_size_oz) !== fix.oz) {
        await knex('products_catalog')
          .where({ id: product.id })
          .update({ container_size: fix.container, unit_size_oz: fix.oz, updated_at: knex.fn.now() });
      }
      if (!hasVendorPricing) continue;
      const siteOne = await knex('vendor_pricing')
        .join('vendors', 'vendors.id', 'vendor_pricing.vendor_id')
        .where('vendor_pricing.product_id', product.id)
        .whereRaw('lower(vendors.name) = ?', ['siteone'])
        .whereIn('vendor_pricing.quantity', [...fix.oldQuantities, fix.container])
        .select('vendor_pricing.id', 'vendor_pricing.price');
      for (const row of siteOne) {
        await knex('vendor_pricing').where({ id: row.id }).update({
          quantity: fix.container,
          ...packFields(row.price, fix.oz),
          updated_at: knex.fn.now(),
        });
      }
      // The canonical best-price writer the inventory screens use: ranking,
      // eligibility, pack scaling, cached winner fields.
      const { recalcBestPrice } = require('../../routes/admin-inventory');
      await recalcBestPrice(product.id, knex);
    }
  }
};

// Data correction; the old sizes were wrong, so there is nothing to restore.
exports.down = async function down() {};
