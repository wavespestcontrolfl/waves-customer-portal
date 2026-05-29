const VERIFIED_AT = new Date('2026-05-28T00:00:00.000Z');
const VERIFIED_BY = 'waveguard-protocol-rate-seed-2026-05-28';

const JSON_FIELDS = ['labeled_turf_species', 'excluded_turf_species', 'rate_notes'];

const RATE_UPDATES = [
  {
    name: 'Prodiamine 65 WDG',
    catalog: {
      category: 'herbicide',
      active_ingredient: 'Prodiamine 65.0%',
      formulation: 'WDG',
      container_size: '5 lb',
      best_price: 68.43,
    },
    fields: {
      default_rate_per_1000: 0.37,
      min_label_rate_per_1000: 0.185,
      max_label_rate_per_1000: 0.83,
      rate_unit: 'oz',
      mixing_order_category: 'dry_wg_wdg_wp_df',
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Prodiamine 65 WDG turf label lists warm-season turf annual rates around 0.36-0.83 oz product per 1,000 sq ft; seeded 0.37 oz/1k for split pre-emergent planning.',
    },
  },
  {
    name: 'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
    catalog: {
      category: 'fertilizer',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 36.77,
    },
    fields: {
      default_rate_per_1000: 2,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 3,
      rate_unit: 'fl_oz',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Seeded conservative foliar micronutrient planning rate for WaveGuard protocol cost audit; verify final label rate against current LESCO AM + Micros label before raising calibrationVerified.',
    },
  },
  {
    name: 'Hydretain Liquid',
    catalog: {
      category: 'soil_amendment',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 184.81,
    },
    fields: {
      default_rate_per_1000: 9,
      min_label_rate_per_1000: 6,
      max_label_rate_per_1000: 9,
      rate_unit: 'fl_oz',
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Hydretain turf maintenance guidance lists 9 fl oz per 1,000 sq ft; seeded as Premium/drought-prep planning default.',
    },
  },
  {
    name: 'LESCO Green Flo 6-0-0 10% Ca',
    aliases: ['Green Flo 6-0-0 Ca'],
    catalog: {
      category: 'fertilizer',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 36.48,
    },
    fields: {
      analysis_n: 6,
      analysis_p: 0,
      analysis_k: 0,
      default_rate_per_1000: 2,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 3,
      rate_unit: 'fl_oz',
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Seeded conservative Green Flo 6-0-0 Ca spoon-feed planning rate for WaveGuard cost audit; verify exact label rate by product lot.',
    },
  },
  {
    name: 'LESCO Green Flo 6-0-0 10% Ca Turfgrass Liquid Fertilizer',
    catalog: {
      category: 'fertilizer',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 36.41,
    },
    fields: {
      analysis_n: 6,
      analysis_p: 0,
      analysis_k: 0,
      default_rate_per_1000: 2,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 3,
      rate_unit: 'fl_oz',
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Seeded conservative Green Flo 6-0-0 Ca spoon-feed planning rate for WaveGuard cost audit; verify exact label rate by product lot.',
    },
  },
  {
    name: 'LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer',
    catalog: {
      category: 'fertilizer',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 116.46,
    },
    fields: {
      analysis_n: 0,
      analysis_p: 0,
      analysis_k: 26,
      default_rate_per_1000: 2,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 3,
      rate_unit: 'fl_oz',
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'SiteOne/LESCO Green Flo Phyte Plus 0-0-26 product guidance lists 1-3 fl oz per 1,000 sq ft; seeded 2 fl oz/1k default.',
    },
  },
  {
    name: 'LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer',
    catalog: {
      category: 'fertilizer',
      formulation: 'granular',
      container_size: '40 lb',
      best_price: 19.28,
    },
    fields: {
      analysis_n: 0,
      analysis_p: 0,
      analysis_k: 18,
      default_rate_per_1000: 1.5,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 3,
      rate_unit: 'lb',
      mixing_order_category: null,
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'Seeded WaveGuard winter potassium planning default for 0-0-18 Bio KMAG from current protocol cost intent; verify final spreader/label rate by bag SKU.',
    },
  },
  {
    name: 'LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer',
    catalog: {
      category: 'fertilizer',
      formulation: 'granular',
      container_size: '50 lb',
      best_price: 92.78,
    },
    fields: {
      analysis_n: 0,
      analysis_p: 0,
      analysis_k: 28,
      default_rate_per_1000: 3.6,
      min_label_rate_per_1000: 1.8,
      max_label_rate_per_1000: 3.6,
      rate_unit: 'lb',
      mixing_order_category: null,
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'SiteOne LESCO Elite 0-0-28 product page lists 3.6 lb product per 1,000 sq ft; seeded as Premium winter potassium planning default.',
    },
  },
  {
    name: 'Anuew EZ Plant Growth Regulator',
    catalog: {
      category: 'pgr',
      active_ingredient: 'Prohexadione-calcium',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 760.25,
    },
    fields: {
      default_rate_per_1000: 0.6,
      min_label_rate_per_1000: 0.2,
      max_label_rate_per_1000: 0.8,
      rate_unit: 'fl_oz',
      mixing_order_category: 'ec_ew',
      irrigation_required: false,
      labeled_turf_species: ['bermuda'],
      excluded_turf_species: ['zoysia', 'st_augustine', 'bahia'],
      label_source_note: 'Anuew EZ turf product guidance lists 0.2-0.8 fl oz per 1,000 sq ft; seeded 0.6 fl oz/1k for Bermuda Premium PGR costing.',
    },
  },
  {
    name: 'Armada 50 WDG',
    catalog: {
      category: 'fungicide',
      formulation: 'WDG',
      container_size: '2 lb',
      best_price: 134.95,
    },
    fields: {
      default_rate_per_1000: 0.3,
      min_label_rate_per_1000: 0.2,
      max_label_rate_per_1000: 1.5,
      rate_unit: 'oz',
      mixing_order_category: 'dry_wg_wdg_wp_df',
      irrigation_required: false,
      labeled_turf_species: ['bermuda', 'zoysia'],
      label_source_note: 'Seeded conservative Armada 50 WDG SDS preventive planning rate for WaveGuard; label annual cap is 4.76 oz/1,000 sq ft and exact disease rates vary by target.',
    },
  },
  {
    name: 'Headway G',
    catalog: {
      category: 'fungicide',
      active_ingredient: 'Azoxystrobin 0.31% + Propiconazole 0.75%',
      formulation: 'granular',
      container_size: '30 lb',
      best_price: 44.58,
    },
    fields: {
      default_rate_per_1000: 3,
      min_label_rate_per_1000: 2,
      max_label_rate_per_1000: 4,
      rate_unit: 'lb',
      mixing_order_category: null,
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia'],
      label_source_note: 'Headway G label/product guidance lists 2-4 lb product per 1,000 sq ft for turf applications except snow mold; seeded 3 lb/1k default.',
    },
  },
  {
    name: 'Medallion SC',
    catalog: {
      category: 'fungicide',
      active_ingredient: 'Fludioxonil',
      formulation: 'SC',
      container_size: '1 gal',
      unit_size_oz: 128,
      best_price: 699,
    },
    fields: {
      default_rate_per_1000: 1,
      min_label_rate_per_1000: 1,
      max_label_rate_per_1000: 2,
      rate_unit: 'fl_oz',
      container_size: '1 gal',
      unit_size_oz: 128,
      mixing_order_category: 'liquid_flowable_sc',
      irrigation_required: false,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia'],
      label_source_note: 'Medallion SC turf guidance lists 1-2 fl oz per 1,000 sq ft depending on disease target; seeded 1 fl oz/1k for large-patch rotation costing.',
    },
  },
  {
    name: 'Torque SC',
    catalog: {
      category: 'fungicide',
      active_ingredient: 'Tebuconazole',
      formulation: 'SC',
      container_size: '1 gal',
      unit_size_oz: 128,
      best_price: 196,
    },
    fields: {
      default_rate_per_1000: 1,
      min_label_rate_per_1000: 0.6,
      max_label_rate_per_1000: 1.1,
      rate_unit: 'fl_oz',
      container_size: '1 gal',
      unit_size_oz: 128,
      mixing_order_category: 'liquid_flowable_sc',
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia'],
      label_source_note: 'Torque SC turf label guidance lists 0.6-1.1 fl oz per 1,000 sq ft for listed turf disease programs; seeded 1 fl oz/1k default.',
    },
  },
  {
    name: 'LESCO Moisture Manager',
    catalog: {
      category: 'soil_amendment',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 155.99,
    },
    fields: {
      default_rate_per_1000: 9,
      min_label_rate_per_1000: 6,
      max_label_rate_per_1000: 9,
      rate_unit: 'fl_oz',
      mixing_order_category: 'liquid_fertilizer',
      irrigation_required: true,
      labeled_turf_species: ['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede'],
      label_source_note: 'LESCO Moisture Manager turf maintenance guidance lists 9 fl oz per 1,000 sq ft; seeded for drought/hydrophobic-site costing.',
    },
  },
];

function prepareUpdates(fields) {
  const updates = { ...fields, label_verified_at: VERIFIED_AT, label_verified_by: VERIFIED_BY, updated_at: new Date() };
  for (const field of JSON_FIELDS) {
    if (updates[field] !== undefined) updates[field] = JSON.stringify(updates[field]);
  }
  return updates;
}

function prepareExistingUpdates(product, existing) {
  const updates = prepareUpdates(product.fields);
  for (const [field, value] of Object.entries(product.catalog || {})) {
    if (value == null) continue;
    const existingValue = existing?.[field];
    const missingText = existingValue == null || String(existingValue).trim() === '';
    const missingNumber = ['best_price', 'unit_size_oz', 'cost_per_unit'].includes(field)
      && (!Number.isFinite(Number(existingValue)) || Number(existingValue) <= 0);
    if (missingText || missingNumber) updates[field] = value;
  }
  if (updates.best_price != null) updates.needs_pricing = false;
  return updates;
}

function prepareInsert(product) {
  const insert = {
    name: product.name,
    active: true,
    needs_pricing: product.catalog?.best_price == null,
    ...product.catalog,
    ...product.fields,
    label_verified_at: VERIFIED_AT,
    label_verified_by: VERIFIED_BY,
    created_at: new Date(),
    updated_at: new Date(),
  };
  for (const field of JSON_FIELDS) {
    if (insert[field] !== undefined) insert[field] = JSON.stringify(insert[field]);
  }
  return insert;
}

async function ensureProduct(knex, product) {
  const existing = await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [product.name])
    .first();
  if (existing) {
    await knex('products_catalog')
      .where({ id: existing.id })
      .update(prepareExistingUpdates(product, existing));
    return existing.id;
  }

  const [created] = await knex('products_catalog')
    .insert(prepareInsert(product))
    .returning('id');
  return created?.id || created;
}

async function ensureAlias(knex, productId, aliasName) {
  if (!productId || !aliasName || !(await knex.schema.hasTable('product_aliases'))) return;

  const existing = await knex('product_aliases')
    .where({ alias_name: aliasName })
    .whereNull('vendor_id')
    .first();

  if (existing) {
    if (existing.product_id !== productId) {
      await knex('product_aliases')
        .where({ id: existing.id })
        .update({ product_id: productId, updated_at: new Date() });
    }
    return;
  }

  await knex('product_aliases').insert({
    product_id: productId,
    alias_name: aliasName,
    vendor_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const product of RATE_UPDATES) {
    const productId = await ensureProduct(knex, product);
    for (const aliasName of product.aliases || []) {
      await ensureAlias(knex, productId, aliasName);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .where({ label_verified_by: VERIFIED_BY })
    .update({
      default_rate_per_1000: null,
      min_label_rate_per_1000: null,
      max_label_rate_per_1000: null,
      rate_unit: null,
      label_verified_at: null,
      label_verified_by: null,
      label_source_note: null,
      updated_at: new Date(),
    });
};
