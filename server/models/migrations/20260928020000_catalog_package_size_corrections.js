/**
 * Catalog package-size corrections (owner-approved 2026-09-27, SiteOne listings).
 *
 * - Dominion 2L 1 gal: the $469.53 SiteOne price is a case of 4 x 1 gal
 *   (the FL gallon is sold by the case), so the pack is 512 oz, not 128.
 * - SedgeHammer 75%: SiteOne sells a 1.33 oz bottle at $59.99, not 64 oz.
 *
 * server/data/pricing.csv carries the same corrections, but the admin pricing
 * import only fills container_size / unit_size_oz when they are empty — a
 * catalog row still holding the old size would scale the corrected vendor
 * per-oz price back up (1.33 oz @ $59.99 against 64 oz = ~$2,887). This fixes
 * the catalog rows themselves.
 *
 * Compare-and-set on the old values: a row an administrator has since changed
 * is left alone (production was corrected by hand on 2026-09-27, so this is a
 * no-op there).
 */
const FIXES = [
  {
    name: 'Dominion 2L 1 gal',
    before: { unit_size_oz: 128 },
    after: { container_size: '4 x 1 gal case', unit_size_oz: 512 },
  },
  {
    name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    before: { unit_size_oz: 64 },
    after: { container_size: '1.33 oz', unit_size_oz: 1.33 },
    // The 64 oz scaling of the old per-oz price; a hand-set price is kept.
    price: { before: 3485.35, after: 59.99 },
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  for (const fix of FIXES) {
    await knex('products_catalog')
      .where({ name: fix.name, ...fix.before })
      .update({ ...fix.after, updated_at: knex.fn.now() });
    if (fix.price) {
      await knex('products_catalog')
        .where({ name: fix.name, best_price: fix.price.before })
        .update({ best_price: fix.price.after, updated_at: knex.fn.now() });
    }
  }
};

// Data correction; the old sizes were wrong, so there is nothing to restore.
exports.down = async function down() {};
