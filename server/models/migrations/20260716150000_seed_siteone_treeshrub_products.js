/**
 * Seed catalog rows + aliases for the SiteOne product substitutions made by
 * the tree & shrub protocol dollarization (TriTek replaces SuffOil-X,
 * Azatin O replaces AzaMax, plus Sequestar EDDHA / Southern Ag copper /
 * Espoma acidifier). Without these rows, matchCatalogProduct finds no
 * product for the new protocol lines on migration-built databases, so
 * completion actions record a note but no structured product usage.
 *
 * Prices are SiteOne 2026-07-16 (owner-approved; Sequestar is the account
 * price). Name-guarded so admin-edited or pre-existing rows are never
 * overwritten; down removes only rows this seed created (tagged via
 * label_source_note).
 */
const SEED_ID = 'seed_siteone_treeshrub_2026_07_16';

const PRODUCTS = [
  {
    name: 'TriTek Spray Oil Emulsion (OMRI)',
    category: 'Insecticide',
    manufacturer: 'BRANDT',
    container_size: '2.5 gal',
    unit_size_oz: 320,
    best_price: 76.02,
    cost_per_unit: 0.2376,
    cost_unit: 'fl_oz',
    aliases: ['TriTek spray oil'],
  },
  {
    name: 'Azatin O Biological Insecticide',
    category: 'Insecticide',
    manufacturer: 'OHP',
    container_size: '1 qt',
    unit_size_oz: 32,
    best_price: 595.92,
    cost_per_unit: 18.6225,
    cost_unit: 'fl_oz',
    aliases: ['Azatin O organic'],
  },
  {
    name: 'Sequestar 6% Fe EDDHA Soluble Micronutrient',
    category: 'Micronutrient Fertilizer',
    manufacturer: 'BRANDT',
    container_size: '5 lb',
    unit_size_oz: 80,
    best_price: 46.05,
    cost_per_unit: 0.5756,
    cost_unit: 'oz',
    aliases: ['EDDHA iron'],
  },
  {
    name: 'Southern Ag Copper Fungicide 27.15%',
    category: 'Fungicide',
    manufacturer: 'Southern Ag',
    container_size: '1 pt',
    unit_size_oz: 16,
    best_price: 36.33,
    cost_per_unit: 2.2706,
    cost_unit: 'fl_oz',
    aliases: ['Liquid copper'],
  },
  {
    name: 'Espoma Organic Soil Acidifier',
    category: 'Soil Amendment',
    manufacturer: 'Espoma',
    container_size: '30 lb',
    unit_size_oz: 480,
    best_price: 53.17,
    cost_per_unit: 1.7723,
    cost_unit: 'lb',
    aliases: ['Organic acidifier'],
  },
];

async function ensureProduct(knex, spec) {
  const existing = await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [spec.name])
    .first();
  if (existing) return existing.id;

  const [created] = await knex('products_catalog')
    .insert({
      name: spec.name,
      category: spec.category,
      manufacturer: spec.manufacturer,
      container_size: spec.container_size,
      unit_size_oz: spec.unit_size_oz,
      best_price: spec.best_price,
      best_vendor: 'SiteOne',
      needs_pricing: false,
      cost_per_unit: spec.cost_per_unit,
      cost_unit: spec.cost_unit,
      active: true,
      customer_visibility: 'internal_only',
      content_status: 'draft',
      label_source_note: SEED_ID,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .returning('id');
  return created?.id || created;
}

async function ensureAlias(knex, productId, aliasName) {
  if (!productId || !aliasName) return;
  const existing = await knex('product_aliases')
    .where({ alias_name: aliasName })
    .whereNull('vendor_id')
    .first();
  // Existing vendor-less aliases may belong to prior seeds/admin edits — do
  // not repoint them (rollback cannot infer the previous owner).
  if (existing) return;

  await knex('product_aliases').insert({
    product_id: productId,
    alias_name: aliasName,
    vendor_id: null,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  const hasAliases = await knex.schema.hasTable('product_aliases');

  for (const spec of PRODUCTS) {
    const productId = await ensureProduct(knex, spec);
    if (hasAliases) {
      for (const alias of spec.aliases) {
        await ensureAlias(knex, productId, alias);
      }
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const seeded = await knex('products_catalog')
    .where({ label_source_note: SEED_ID })
    .whereIn('name', PRODUCTS.map((p) => p.name))
    .select('id');
  const seededIds = seeded.map((row) => row.id);
  if (!seededIds.length) return;

  if (await knex.schema.hasTable('product_aliases')) {
    await knex('product_aliases')
      .whereIn('product_id', seededIds)
      .whereIn('alias_name', PRODUCTS.flatMap((p) => p.aliases))
      .del();
  }
  await knex('products_catalog').whereIn('id', seededIds).del();
};
