/**
 * Seed the Velista (penthiopyrad, FRAC 7) fungicide into products_catalog and
 * finish the PR #2205 FRAC-correction backfills that only the protocol/CSV text
 * carried (existing catalog rows + structured rows need direct DB updates).
 *
 * 1. Velista was added to the Zoysia December large-patch slot to break the
 *    FRAC-3 rotation overlap, but it had no catalog row — so the plan builder
 *    (waveguard-plan-engine.js, which resolves protocol text against
 *    products_catalog) and the material-cost audit couldn't price/rate it. This
 *    adds the real inventory row: Syngenta Velista 22 oz @ $297.00 ($13.50/oz),
 *    label rate 0.5 oz/1,000 sq ft, and links the structured lawn_protocol_products
 *    'Velista' row (seeded with product_id NULL in 20260529000003).
 * 2. Backfills products_catalog.frac_group for Medallion SC (12) and Torque SC (3)
 *    — pricing.csv only feeds fresh imports, but waveguard-approval-engine reads
 *    products_catalog.frac_group for fungicide rotation blocks on existing DBs.
 * Idempotent throughout.
 */

const PRODUCT = {
  name: 'Velista',
  category: 'fungicide', // lowercase — waveguard-approval-engine matches sp.product_category exactly
  active: true,
  active_ingredient: 'Penthiopyrad',
  formulation: 'WDG',
  // products_catalog.epa_reg_number is NOT NULL, and report-data.js rejects 'N/A'
  // pesticide rows. Syngenta Velista WDG = EPA Reg. No. 100-1534
  // (greencastonline.com/labels/velista; EPA PPLS 000100-01534). NB: 100-1241 is
  // Palisade/Moddus, not Velista.
  epa_reg_number: '100-1534',
  frac_group: '7',
  analysis_n: 0,
  analysis_p: 0,
  analysis_k: 0,
  default_rate_per_1000: 0.5,
  min_label_rate_per_1000: 0.3,
  max_label_rate_per_1000: 0.7,
  rate_unit: 'oz',
  mixing_order_category: 'dry_wg_wdg_wp_df',
  label_source_note:
    'Velista WDG turf label lists ~0.3-0.7 oz per 1,000 sq ft by disease target; seeded 0.5 oz/1k for the Zoysia large-patch rotation (conditional, large-patch history). Price: Syngenta/SiteOne 22 oz @ $297.00. EPA reg 100-1534; exact rates pending owner label verification.',
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
        content_status: 'draft', // products_catalog_content_status_check allows draft/approved_*/retired
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning('id');
    productId = row && (row.id || row);
  }

  // Alias so the protocol text "Velista" and any "Velista SC/WDG" variants resolve.
  // Only insert an alias when one with that name does not already exist (so we
  // never adopt or clobber a pre-existing mapping owned by another product).
  if (productId && (await knex.schema.hasTable('product_aliases'))) {
    for (const aliasName of ['Velista SC', 'Velista WDG']) {
      const exists = await knex('product_aliases').where({ alias_name: aliasName }).first();
      if (!exists) {
        await knex('product_aliases').insert({
          product_id: productId,
          alias_name: aliasName,
          vendor_id: null,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now(),
        });
      }
    }
  }

  // Link the structured Velista row (20260529000003 seeded it with product_id NULL,
  // since the catalog row did not exist yet) so the Command Center prices it.
  if (productId && (await knex.schema.hasTable('lawn_protocol_products'))) {
    await knex('lawn_protocol_products')
      .where({ product_name: 'Velista' })
      .whereNull('product_id')
      .update({ product_id: productId, updated_at: knex.fn.now() });
  }

  // Backfill corrected FRAC groups on existing catalog rows (PR #2205 relabel):
  // Medallion (fludioxonil) = FRAC 12, Torque (tebuconazole) = FRAC 3.
  for (const [name, frac] of [['Medallion SC', '12'], ['Torque SC', '3']]) {
    await knex('products_catalog')
      .where({ name })
      .update({ frac_group: frac, updated_at: knex.fn.now() });
  }
};

exports.down = async function down() {
  // Non-destructive seed: leave the catalog row (it may have accrued inventory /
  // movement history) and the aliases (down() can't prove this migration owns a
  // given alias row vs. a pre-existing/manual one, so deleting by name is unsafe).
};
