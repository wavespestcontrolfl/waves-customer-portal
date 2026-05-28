const SEED_ID = 'protocol_canonical_price_seed_v1';

const CANONICAL_PRICES = [
  {
    productName: 'LESCO 24-0-11',
    canonicalName: 'LESCO 24-0-11 75% PolyPlus OPTI',
    canonicalSku: 'LESCO-24-0-11-POLYPLUS',
    category: 'fertilizer',
    price: 33.79,
    packageSize: 50,
    packageUnit: 'lb',
    costUnit: 'lb',
    aliases: ['LESCO 24-0-11 75% PolyPlus OPTI', 'LESCO 24-0-11 PolyPlus fert', 'LESCO 24-0-11 fert'],
    note: 'Approved protocol-family mapping from generic LESCO 24-0-11 to priced 75% PolyPlus OPTI row.',
  },
  {
    productName: 'LESCO 12-0-0 Chelated Iron Plus',
    canonicalName: 'LESCO Chelated Iron Plus 12-0-0 2%Mn 6%Fe 4%S',
    canonicalSku: 'LESCO-CHELATED-IRON-12-0-0',
    category: 'fertilizer',
    price: 34.80,
    packageSize: 2.5,
    packageUnit: 'gal',
    costUnit: 'oz',
    aliases: ['Chelated Iron Plus', 'LESCO Chelated Iron Plus', 'LESCO Chelated Iron Plus 12-0-0'],
    note: 'Approved protocol-family mapping to the lowest current Chelated Iron Plus priced row in server/data/pricing.csv.',
  },
  {
    productName: 'LESCO K-Flow 0-0-25',
    canonicalName: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer',
    canonicalSku: 'LESCO-K-FLOW-0-0-25',
    category: 'fertilizer',
    price: 38.02,
    packageSize: 2.5,
    packageUnit: 'gal',
    costUnit: 'oz',
    aliases: ['K-Flow', 'K-Flow 0-0-25', 'K Flow 0-0-25', 'LESCO K-Flow 0-0-25 17% S'],
    note: 'Approved protocol-family mapping using corrected 2.5 gal package row; legacy 1.33 oz size was not used.',
  },
  {
    productName: 'Hydretain Liquid',
    canonicalName: 'Hydretain Liquid Humectant',
    canonicalSku: 'HYDRETAIN-LIQUID-HUMECTANT',
    category: 'adjuvant',
    price: 184.81,
    packageSize: 2.5,
    packageUnit: 'gal',
    costUnit: 'oz',
    aliases: ['Hydretain', 'Hydretain Liquid Humectant', 'Moisture Manager'],
    note: 'Added missing protocol catalog row from priced Hydretain Liquid Humectant row.',
    createIfMissing: true,
    activeIngredient: 'Humectant blend',
    formulation: 'liquid',
    epaRegNumber: 'Adjuvant - no EPA reg',
  },
  {
    productName: 'Primo Maxx',
    canonicalName: 'Primo Maxx Plant Growth Regulator for Turf',
    canonicalSku: 'PRIMO-MAXX-1GAL',
    category: 'pgr',
    price: 320.00,
    packageSize: 1,
    packageUnit: 'gal',
    costUnit: 'oz',
    aliases: ['Primo', 'Primo Maxx PGR', 'Primo Maxx Plant Growth Regulator'],
    note: 'Approved protocol-family mapping to Primo Maxx Plant Growth Regulator, 1 gal.',
  },
  {
    productName: 'SpeedZone Southern',
    canonicalName: 'SpeedZone Southern EW',
    canonicalSku: 'SPEEDZONE-SOUTHERN-EW',
    category: 'herbicide',
    price: 192.50,
    packageSize: 2.5,
    packageUnit: 'gal',
    costUnit: 'oz',
    aliases: ['SpeedZone', 'SpeedZone Southern EW', 'SpeedZone Southern + NIS'],
    note: 'Approved protocol-family mapping from generic SpeedZone Southern to SpeedZone Southern EW, 2.5 gal.',
  },
];

function packageToOz(size, unit) {
  const factors = { oz: 1, lb: 16, gal: 128, g: 0.035274 };
  return Number((Number(size) * factors[unit]).toFixed(4));
}

function costPerUnit(row) {
  if (row.costUnit === row.packageUnit) return Number((row.price / row.packageSize).toFixed(4));
  if (row.costUnit === 'oz') return Number((row.price / packageToOz(row.packageSize, row.packageUnit)).toFixed(4));
  return Number((row.price / row.packageSize).toFixed(4));
}

async function findOrCreateProduct(knex, row) {
  let product = await knex('products_catalog').where({ name: row.productName }).first();
  if (product || !row.createIfMissing) return product;

  const [created] = await knex('products_catalog')
    .insert({
      name: row.productName,
      category: row.category,
      active: true,
      active_ingredient: row.activeIngredient || null,
      formulation: row.formulation || null,
      epa_reg_number: row.epaRegNumber || null,
      container_size: `${row.packageSize} ${row.packageUnit}`,
      unit_size_oz: packageToOz(row.packageSize, row.packageUnit),
      inventory_unit: row.packageUnit,
      needs_pricing: true,
      customer_visibility: 'internal_only',
      content_status: 'draft',
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .returning('*');
  return created;
}

async function ensureAlias(knex, productId, aliasName) {
  if (!aliasName) return;
  const existing = await knex('product_aliases')
    .where({ alias_name: aliasName })
    .whereNull('vendor_id')
    .first();
  if (existing) {
    if (existing.product_id !== productId) {
      await knex('product_aliases').where({ id: existing.id }).update({ product_id: productId, updated_at: knex.fn.now() });
    }
    return;
  }
  await knex('product_aliases').insert({
    product_id: productId,
    alias_name: aliasName,
    vendor_id: null,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

async function ensureMapping(knex, product, vendor, connection, row) {
  const sku = row.canonicalSku || row.canonicalName;
  const existing = await knex('distributor_product_map')
    .where({ product_id: product.id, vendor_id: vendor.id, distributor_sku: sku })
    .first();
  const data = {
    product_id: product.id,
    vendor_id: vendor.id,
    vendor_connection_id: connection.id,
    distributor_sku: sku,
    manufacturer_sku: sku,
    source_url: 'server/data/pricing.csv',
    product_url: 'server/data/pricing.csv',
    vendor_product_name: row.canonicalName,
    pack_size: `${row.packageSize} ${row.packageUnit}`,
    uom: 'Each',
    package_size_value: row.packageSize,
    package_size_unit: row.packageUnit,
    purchase_uom: 'Each',
    content_quantity: row.packageSize,
    content_uom: row.packageUnit,
    case_quantity: 1,
    pack_count: 1,
    mapping_status: 'verified',
    confidence_score: 0.85,
    mapping_confidence: 0.85,
    verified_at: knex.fn.now(),
    last_checked_at: knex.fn.now(),
    active: true,
    notes: `${row.note} Seed ${SEED_ID}.`,
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('distributor_product_map').where({ id: existing.id }).update(data);
    return { ...existing, ...data };
  }
  const [created] = await knex('distributor_product_map')
    .insert({ ...data, created_at: knex.fn.now() })
    .returning('*');
  return created;
}

async function ensurePricing(knex, product, vendor, connection, mapping, row) {
  const unitCost = costPerUnit(row);
  const packageOz = packageToOz(row.packageSize, row.packageUnit);
  await knex('products_catalog').where({ id: product.id }).update({
    container_size: `${row.packageSize} ${row.packageUnit}`,
    unit_size_oz: packageOz,
    best_price: row.price,
    best_vendor: vendor.name,
    needs_pricing: false,
    cost_per_unit: unitCost,
    cost_unit: row.costUnit,
    best_price_amount_cached: row.price,
    best_price_vendor_id_cached: vendor.id,
    best_price_updated_at: knex.fn.now(),
    best_price_status: 'current',
    updated_at: knex.fn.now(),
  });

  let pricing = await knex('vendor_pricing').where({ product_id: product.id, vendor_id: vendor.id }).first();
  const pricingData = {
    vendor_connection_id: connection.id,
    distributor_product_map_id: mapping.id,
    price: row.price,
    price_amount: row.price,
    currency: 'USD',
    quantity: 'Each (1)',
    unit: row.costUnit,
    vendor_product_url: 'server/data/pricing.csv',
    vendor_sku: row.canonicalSku || row.canonicalName,
    normalized_unit_price: unitCost,
    price_per_oz: row.costUnit === 'oz' ? unitCost : null,
    landed_unit_price: unitCost,
    unit_normalized: row.costUnit,
    source_type: 'manual_seed',
    price_type: 'account',
    approval_status: 'approved',
    confidence_score: 0.85,
    mapping_confidence: 0.85,
    source_confidence: 0.85,
    price_confidence: 0.85,
    availability: 'Canonical priced protocol row',
    availability_status: 'unknown',
    expires_at: knex.raw("now() + interval '45 days'"),
    last_checked_at: knex.fn.now(),
    is_active: true,
    updated_at: knex.fn.now(),
  };

  if (pricing) {
    await knex('vendor_pricing').where({ id: pricing.id }).update(pricingData);
    pricing = await knex('vendor_pricing').where({ id: pricing.id }).first();
  } else {
    [pricing] = await knex('vendor_pricing')
      .insert({
        product_id: product.id,
        vendor_id: vendor.id,
        ...pricingData,
        is_best_price: false,
        created_at: knex.fn.now(),
      })
      .returning('*');
  }

  const [snapshot] = await knex('price_snapshots')
    .insert({
      vendor_pricing_id: pricing.id,
      product_id: product.id,
      vendor_id: vendor.id,
      vendor_connection_id: connection.id,
      distributor_product_map_id: mapping.id,
      price: row.price,
      price_amount: row.price,
      currency: 'USD',
      raw_price_text: `$${row.price.toFixed(2)} / Each (1); normalized to $${unitCost}/${row.costUnit}`,
      raw_payload_json: JSON.stringify({ seed: SEED_ID, canonicalName: row.canonicalName, note: row.note }),
      quantity: 'Each (1)',
      uom: row.costUnit,
      normalized_unit_price: unitCost,
      normalized_unit: row.costUnit,
      landed_unit_price: unitCost,
      availability: 'Canonical priced protocol row',
      availability_status: 'unknown',
      source_type: 'manual_seed',
      source_url: 'server/data/pricing.csv',
      price_type: 'account',
      confidence_score: 0.85,
      mapping_confidence: 0.85,
      source_confidence: 0.85,
      price_confidence: 0.85,
      requires_approval: false,
      fetched_at: knex.fn.now(),
      captured_at: knex.fn.now(),
      expires_at: knex.raw("now() + interval '45 days'"),
      metadata: JSON.stringify({ seed: SEED_ID, canonicalName: row.canonicalName, note: row.note }),
      created_at: knex.fn.now(),
    })
    .returning('*');

  await knex('vendor_pricing').where({ id: pricing.id }).update({ latest_snapshot_id: snapshot.id, updated_at: knex.fn.now() });
  await knex('products_catalog').where({ id: product.id }).update({ best_vendor_pricing_id: pricing.id, updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog')) || !(await knex.schema.hasTable('vendors'))) return;

  const vendor = await knex('vendors').whereRaw('lower(name) = ?', ['siteone']).first()
    || await knex('vendors').whereILike('name', '%SiteOne%').first();
  if (!vendor) return;

  let connection = await knex('vendor_connections')
    .where({ vendor_id: vendor.id, connection_type: 'manual_seed' })
    .first();
  if (!connection && await knex.schema.hasTable('vendor_connections')) {
    [connection] = await knex('vendor_connections')
      .insert({
        vendor_id: vendor.id,
        connection_type: 'manual_seed',
        approval_status: 'approved',
        credential_status: 'not_required',
        supports_account_pricing: true,
        supports_bulk_pricing: true,
        config_json: JSON.stringify({ seed: SEED_ID }),
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning('*');
  }
  if (!connection) return;

  for (const row of CANONICAL_PRICES) {
    const product = await findOrCreateProduct(knex, row);
    if (!product) continue;
    for (const alias of [row.canonicalName, ...row.aliases]) {
      await ensureAlias(knex, product.id, alias);
    }
    const mapping = await ensureMapping(knex, product, vendor, connection, row);
    await ensurePricing(knex, product, vendor, connection, mapping, row);
  }
};

exports.down = async function down() {
  // Data migration only. Historical price snapshots are intentionally retained.
};
