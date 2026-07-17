/**
 * Seed catalog rows + aliases for the SiteOne product substitutions made by
 * the tree & shrub protocol dollarization (TriTek replaces SuffOil-X,
 * Azatin O replaces AzaMax, plus Sequestar EDDHA / Southern Ag copper /
 * Espoma acidifier). Without these rows, matchCatalogProduct finds no
 * product for the new protocol lines on migration-built databases, so
 * completion actions record a note but no structured product usage.
 *
 * Prices are SiteOne 2026-07-16 (owner-approved; Sequestar is the account
 * price). default_rate_per_1000 values are seeded operating assumptions
 * (carrier ~2.5 gal/1,000 sq ft on foliar products) pending owner label
 * verification — same convention as the Velista seed (20260629000001).
 * Name-guarded so admin-edited or pre-existing rows are never overwritten;
 * down is non-destructive (see below) — seeded rows stay identifiable via
 * label_source_note.
 */
const SEED_ID = 'seed_siteone_treeshrub_2026_07_16';

const PRODUCTS = [
  // active_ingredient/epa_reg_number are NOT NULL on migration-built
  // databases (20260517000004 SET NOT NULL — silently failed on prod, but
  // succeeds on fresh envs). EPA numbers are from the current product
  // labels; non-pesticide rows follow the catalog's 'N/A' convention.
  {
    name: 'TriTek Spray Oil Emulsion (OMRI)',
    category: 'insecticide', // lowercase — waveguard-approval-engine matches exactly
    application_method: 'foliar_spray',
    manufacturer: 'BRANDT',
    active_ingredient: 'Mineral oil 80%',
    epa_reg_number: '48813-1',
    formulation: 'liquid',
    rate_unit: 'fl_oz',
    inventory_unit: 'fl_oz',
    // Dilution product — the protocol specifies 1.0-1.5% v/v tank
    // concentration (1.28-1.92 fl oz/gal). Seeded via the default_rate +
    // /gal default_unit path so closeout prefills the label band's low end
    // as a mix concentration; a per-1k rate here would render as a bare
    // "Rate" with no carrier context (foliar apps have no sqft requirement).
    default_rate: '1.28-1.92',
    default_unit: 'fl_oz/gal',
    container_size: '2.5 gal',
    unit_size_oz: 320,
    best_price: 76.02,
    cost_per_unit: 0.2376,
    cost_unit: 'fl_oz',
    aliases: ['TriTek spray oil'],
  },
  {
    name: 'Azatin O Biological Insecticide',
    category: 'insecticide',
    application_method: 'foliar_spray',
    manufacturer: 'OHP',
    active_ingredient: 'Azadirachtin 4.5%',
    epa_reg_number: '70051-9-59807',
    formulation: 'liquid',
    rate_unit: 'fl_oz',
    inventory_unit: 'fl_oz',
    // Dilution product — 10 fl oz/100 gal foliar = 0.1 fl oz/gal mix
    // concentration (same default_rate + /gal unit path as TriTek).
    default_rate: '0.1',
    default_unit: 'fl_oz/gal',
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
    // Soil-drench corrective — without an explicit method the closeout
    // would infer granular_broadcast from the 'Fertilizer' category.
    application_method: 'soil_drench',
    manufacturer: 'BRANDT',
    active_ingredient: '6% Fe (EDDHA chelate)',
    epa_reg_number: 'N/A',
    formulation: 'dry soluble',
    rate_unit: 'oz',
    inventory_unit: 'oz',
    // Soil-drench corrective for high-pH chlorosis; ~1.5 oz per 1,000 sq ft
    // of affected bed/root zone.
    default_rate_per_1000: 1.5,
    container_size: '5 lb',
    unit_size_oz: 80,
    best_price: 46.05,
    cost_per_unit: 0.5756,
    cost_unit: 'oz',
    aliases: ['EDDHA iron'],
  },
  {
    name: 'Southern Ag Copper Fungicide 27.15%',
    category: 'fungicide',
    application_method: 'foliar_spray',
    manufacturer: 'Southern Ag',
    active_ingredient: 'Copper diammonia diacetate complex 27.15%',
    epa_reg_number: '10465-3-829',
    formulation: 'liquid',
    rate_unit: 'fl_oz',
    inventory_unit: 'fl_oz',
    // Dilution product — label 1-2 tsp/gal (27.15% concentrate) =
    // 0.17-0.33 fl oz/gal, kept in fl_oz/gal to match the rate and
    // inventory units.
    default_rate: '0.17-0.33',
    default_unit: 'fl_oz/gal',
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
    // Granular bed corrective — without an explicit method the closeout
    // would fall through to the tree/shrub foliar_spray default.
    application_method: 'granular_broadcast',
    manufacturer: 'Espoma',
    active_ingredient: 'Elemental sulfur 30%',
    epa_reg_number: 'N/A',
    formulation: 'granular',
    rate_unit: 'lb',
    inventory_unit: 'lb',
    // Bed-area pH corrective; label ranges are per-plant/bed — seeded at a
    // conservative 5 lb per 1,000 sq ft of treated bed.
    default_rate_per_1000: 5,
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
      active_ingredient: spec.active_ingredient,
      epa_reg_number: spec.epa_reg_number,
      formulation: spec.formulation,
      rate_unit: spec.rate_unit,
      inventory_unit: spec.inventory_unit,
      // Area-based products carry a per-1k rate; dilution products carry a
      // /gal mix-concentration band instead (closeout prefills its low end).
      default_rate_per_1000: spec.default_rate_per_1000 ?? null,
      default_rate: spec.default_rate ?? null,
      default_unit: spec.default_unit ?? null,
      application_method: spec.application_method ?? null,
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

  // Explicit application method for closeout prefill — SchedulePage's
  // defaultApplicationMethod honors this before its category/formulation
  // heuristics, which misclassify the soil products here (EDDHA reads as
  // granular via 'Fertilizer'; Espoma falls to the T&S foliar default).
  // Guarded: the column is new with this migration.
  if (!(await knex.schema.hasColumn('products_catalog', 'application_method'))) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.string('application_method', 50);
    });
  }

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

exports.down = async function down() {
  // Non-destructive by design: once completion actions attach these
  // products, catalog rows accrue operational references — and
  // product_inventory_movements.product_id is ON DELETE CASCADE
  // (20260504000001), so deleting the rows on an ordinary deployment
  // rollback would erase job-cost and inventory audit history. Seeded rows
  // stay identifiable via label_source_note = 'seed_siteone_treeshrub_2026_07_16'
  // if manual cleanup is ever wanted.
};
