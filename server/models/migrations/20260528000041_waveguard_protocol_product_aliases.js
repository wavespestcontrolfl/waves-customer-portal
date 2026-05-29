const SEED_ID = 'waveguard-protocol-alias-seed-2026-05-28';
const SEED_RECORD_TABLE = 'waveguard_protocol_alias_seed_records';

const PRODUCT_ALIASES = [
  {
    name: 'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment',
    createIfMissing: true,
    catalog: {
      category: 'soil_amendment',
      active_ingredient: 'Humic acids, fulvic acids, MobilEX biostimulant',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 331.25,
      cost_per_unit: 1.0352,
      cost_unit: 'fl_oz',
      default_rate_per_1000: 1.375,
      rate_unit: 'fl_oz',
      needs_pricing: false,
    },
    aliases: [
      'CarbonPro-L',
      'CarbonPro-L biostimulant',
      'Premium: CarbonPro-L',
    ],
  },
  {
    name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
    createIfMissing: true,
    catalog: {
      category: 'fertilizer',
      active_ingredient: 'Micronutrients: Mg, S, Fe, Mn',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      needs_pricing: true,
    },
    aliases: [
      'High Mn Combo',
      'High Mn Combo micros',
      'Premium: High Mn Combo',
    ],
  },
  {
    name: 'Dispatch Sprayable Wetting Agent',
    createIfMissing: true,
    catalog: {
      category: 'soil_surfactant',
      active_ingredient: 'Alkoxylated polyols + glucoethers',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 307.75,
      cost_per_unit: 0.9617,
      cost_unit: 'fl_oz',
      default_rate_per_1000: 1.223,
      rate_unit: 'fl_oz',
      needs_pricing: false,
    },
    aliases: [
      'Dispatch',
      'Dispatch wetting agent',
      'Premium: Dispatch wetting agent',
    ],
  },
  {
    name: 'Topchoice Granular Insecticide',
    createIfMissing: true,
    catalog: {
      category: 'insecticide',
      active_ingredient: 'Fipronil 0.0143%',
      formulation: 'granular',
      container_size: '50 lb',
      best_price: 89.58,
      cost_per_unit: 1.7916,
      cost_unit: 'lb',
      default_rate_per_1000: 2,
      rate_unit: 'lb',
      needs_pricing: false,
    },
    aliases: [
      'Topchoice',
      'Topchoice BROADCAST',
      'Topchoice fall app',
    ],
  },
  {
    name: 'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
    createIfMissing: true,
    catalog: {
      category: 'fungicide',
      active_ingredient: 'Thiophanate-methyl 46.2%',
      formulation: 'flowable',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      needs_pricing: true,
    },
    aliases: [
      'T-Storm',
      'T-Storm CONDITIONAL',
    ],
  },
  {
    name: 'LESCO Three-Way Selective Herbicide',
    createIfMissing: true,
    catalog: {
      category: 'herbicide',
      active_ingredient: '2,4-D + MCPP + Dicamba',
      formulation: 'liquid',
      container_size: '2.5 gal',
      unit_size_oz: 320,
      best_price: 104.82,
      cost_per_unit: 0.3276,
      cost_unit: 'fl_oz',
      default_rate_per_1000: 0.916,
      rate_unit: 'fl_oz',
      needs_pricing: false,
    },
    aliases: [
      'Three-Way',
      'Three-Way if too warm',
      'OR Three-Way',
    ],
  },
  {
    name: 'Dismiss NXT',
    aliases: [
      'Dismiss',
      'Dismiss if sedge',
      'Dismiss for sedge',
      'Dismiss for fall sedge',
    ],
  },
  {
    name: 'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
    createIfMissing: true,
    catalog: {
      category: 'herbicide',
      active_ingredient: 'Halosulfuron-methyl',
      formulation: 'soluble granule',
      container_size: '13.5 g',
      needs_pricing: true,
    },
    aliases: [
      'Sedgehammer Plus',
      'Sedgehammer Plus if sedge',
    ],
  },
  {
    name: 'Headway G',
    aliases: [
      'Headway',
      'Headway ONLY if severe',
      'Headway winter slot',
    ],
  },
  {
    name: 'Torque SC',
    aliases: [
      'Torque',
      'OR Torque',
    ],
  },
  {
    name: 'LESCO Green Flo 6-0-0 10% Ca',
    aliases: [
      'Green Flo 6-0-0 Ca',
    ],
  },
  {
    name: 'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient',
    aliases: [
      'Chelated AM',
      'Chelated AM + Micros',
      'Premium: Chelated AM + Micros',
    ],
  },
];

function definedCatalogFields(catalog = {}) {
  return Object.fromEntries(
    Object.entries(catalog).filter(([, value]) => value !== undefined)
  );
}

async function ensureProduct(knex, row) {
  const existing = await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [row.name])
    .first();

  if (existing) {
    const updates = {
      ...definedCatalogFields(row.catalog),
      updated_at: knex.fn.now(),
    };
    if (Object.keys(updates).length > 1) {
      await knex('products_catalog').where({ id: existing.id }).update(updates);
    }
    return existing.id;
  }

  if (!row.createIfMissing) return null;

  const [created] = await knex('products_catalog')
    .insert({
      name: row.name,
      active: true,
      customer_visibility: 'internal_only',
      content_status: 'draft',
      label_verified_by: SEED_ID,
      ...definedCatalogFields(row.catalog),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .returning('id');
  return created?.id || created;
}

async function ensureSeedRecordTable(knex) {
  if (await knex.schema.hasTable(SEED_RECORD_TABLE)) return;

  await knex.schema.createTable(SEED_RECORD_TABLE, (table) => {
    table.increments('id').primary();
    table.string('seed_id').notNullable();
    table.uuid('alias_id').notNullable();
    table.string('alias_name').notNullable();
    table.uuid('product_id').notNullable();
    table.timestamps(true, true);
    table.unique(['seed_id', 'alias_id']);
  });
}

async function recordInsertedAlias(knex, { aliasId, productId, aliasName }) {
  if (!aliasId || !(await knex.schema.hasTable(SEED_RECORD_TABLE))) return;

  const existing = await knex(SEED_RECORD_TABLE)
    .where({ seed_id: SEED_ID, alias_id: aliasId })
    .first();
  if (existing) return;

  await knex(SEED_RECORD_TABLE).insert({
    seed_id: SEED_ID,
    alias_id: aliasId,
    alias_name: aliasName,
    product_id: productId,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

async function ensureAlias(knex, productId, aliasName) {
  if (!productId || !aliasName) return;
  const existing = await knex('product_aliases')
    .where({ alias_name: aliasName })
    .whereNull('vendor_id')
    .first();

  if (existing) {
    // Existing vendor-less aliases may belong to prior migrations. Do not
    // repoint them; rollback cannot safely infer the previous owner.
    return;
  }

  const [created] = await knex('product_aliases').insert({
    product_id: productId,
    alias_name: aliasName,
    vendor_id: null,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  }).returning('id');
  const aliasId = created?.id || created;
  await recordInsertedAlias(knex, { aliasId, productId, aliasName });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('product_aliases'))) return;
  await ensureSeedRecordTable(knex);

  for (const row of PRODUCT_ALIASES) {
    const productId = await ensureProduct(knex, row);
    for (const aliasName of row.aliases || []) {
      await ensureAlias(knex, productId, aliasName);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_aliases'))) return;

  if (!(await knex.schema.hasTable('products_catalog'))) return;

  if (await knex.schema.hasTable(SEED_RECORD_TABLE)) {
    const insertedAliasIds = (await knex(SEED_RECORD_TABLE)
      .where({ seed_id: SEED_ID })
      .select('alias_id'))
      .map((row) => row.alias_id)
      .filter(Boolean);

    if (insertedAliasIds.length) {
      await knex('product_aliases')
        .whereIn('id', insertedAliasIds)
        .del();
    }

    await knex.schema.dropTable(SEED_RECORD_TABLE);
  }

  const createdProducts = await knex('products_catalog')
    .where({ label_verified_by: SEED_ID })
    .whereIn('name', PRODUCT_ALIASES.filter((row) => row.createIfMissing).map((row) => row.name))
    .select('id');
  const createdProductIds = createdProducts.map((row) => row.id).filter(Boolean);

  if (createdProductIds.length) {
    await knex('product_aliases')
      .whereIn('product_id', createdProductIds)
      .whereNull('vendor_id')
      .del();

    await knex('products_catalog')
      .whereIn('id', createdProductIds)
      .del();
  }
};
