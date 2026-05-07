/**
 * Mosquito pricing refresh — May 2026
 *
 * Adds current COGS products and moves estimator-facing mosquito pricing away
 * from metal tier names to actual program options:
 * essential/precision barrier, seasonal/monthly cadence.
 */
exports.up = async function (knex) {
  const hasProducts = await knex.schema.hasTable('products_catalog');
  const hasVendors = await knex.schema.hasTable('vendors');
  const hasVendorPricing = await knex.schema.hasTable('vendor_pricing');
  const hasUsage = await knex.schema.hasTable('service_product_usage');

  async function ensureVendor(name) {
    if (!hasVendors) return null;
    const existing = await knex('vendors').whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first();
    if (existing) return existing.id;
    const [row] = await knex('vendors').insert({ name, active: true }).returning('id');
    return row?.id || row;
  }

  async function ensureProduct(product) {
    if (!hasProducts) return null;
    const existing = await knex('products_catalog').whereRaw('LOWER(name) = ?', [product.name.toLowerCase()]).first();
    if (existing) {
      await knex('products_catalog').where({ id: existing.id }).update(product);
      return existing.id;
    }
    const [row] = await knex('products_catalog').insert(product).returning('id');
    return row?.id || row;
  }

  async function ensureVendorPrice(productId, vendorName, price, quantity, unit) {
    if (!productId || !hasVendorPricing) return;
    const vendorId = await ensureVendor(vendorName);
    if (!vendorId) return;
    const existing = await knex('vendor_pricing').where({ product_id: productId, vendor_id: vendorId }).first();
    const data = {
      product_id: productId,
      vendor_id: vendorId,
      price,
      quantity,
      unit,
      is_best_price: true,
      last_checked_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    };
    if (existing) await knex('vendor_pricing').where({ id: existing.id }).update(data);
    else await knex('vendor_pricing').insert(data);
  }

  async function ensureUsage(serviceType, productId, data) {
    if (!productId || !hasUsage) return;
    const existing = await knex('service_product_usage').where({ service_type: serviceType, product_id: productId }).first();
    const row = { service_type: serviceType, product_id: productId, ...data };
    if (existing) await knex('service_product_usage').where({ id: existing.id }).update(row);
    else await knex('service_product_usage').insert(row);
  }

  const bifenId = await ensureProduct({
    name: 'Bifen I/T',
    category: 'insecticide',
    active_ingredient: 'Bifenthrin',
    moa_group: 'Group 3A',
    container_size: '1 gal',
    unit_size_oz: 128,
    best_price: 41.08,
    best_vendor: 'Amazon',
    cost_per_unit: 41.08 / 128,
    cost_unit: 'oz',
    needs_pricing: false,
    active: true,
  });

  const talakId = await ensureProduct({
    name: 'Atticus Talak',
    category: 'Insecticide',
    active_ingredient: '7.9% Bifenthrin',
    moa_group: 'Group 3A',
    container_size: '1 gal',
    unit_size_oz: 128,
    best_price: 41.57,
    best_vendor: 'Amazon',
    cost_per_unit: 41.57 / 128,
    cost_unit: 'oz',
    needs_pricing: false,
    active: true,
  });

  const tekkoId = await ensureProduct({
    name: 'Tekko Pro IGR',
    category: 'IGR',
    active_ingredient: 'Pyriproxyfen + Novaluron',
    container_size: '16 oz',
    unit_size_oz: 16,
    best_price: 52.97,
    best_vendor: 'Amazon',
    cost_per_unit: 52.97 / 16,
    cost_unit: 'oz',
    needs_pricing: false,
    active: true,
  });

  const scionId = await ensureProduct({
    name: 'Scion Insecticide',
    category: 'Insecticide',
    active_ingredient: 'Gamma-cyhalothrin',
    moa_group: 'Group 3A',
    container_size: '32 oz',
    unit_size_oz: 32,
    best_price: 161.30,
    best_vendor: 'SiteOne',
    cost_per_unit: 161.30 / 32,
    cost_unit: 'oz',
    needs_pricing: false,
    active: true,
  });

  const in2CareId = await ensureProduct({
    name: 'In2Care Mosquito Station',
    category: 'mosquito',
    container_size: '1 station',
    best_price: 13.14,
    best_vendor: 'SiteOne',
    cost_per_unit: 13.14,
    cost_unit: 'station',
    needs_pricing: false,
    active: true,
  });

  const dunkId = await ensureProduct({
    name: 'Summit Mosquito Dunk Tablets',
    category: 'mosquito',
    active_ingredient: 'Bti',
    container_size: '20 count',
    best_price: 26.88,
    best_vendor: 'Amazon',
    cost_per_unit: 26.88 / 20,
    cost_unit: 'tablet',
    needs_pricing: false,
    active: true,
  });

  await ensureVendorPrice(bifenId, 'Amazon', 41.08, '1 gal', 'gal');
  await ensureVendorPrice(talakId, 'Amazon', 41.57, '1 gal', 'gal');
  await ensureVendorPrice(tekkoId, 'Amazon', 52.97, '16 oz', 'oz');
  await ensureVendorPrice(scionId, 'SiteOne', 161.30, '32 oz', 'oz');
  await ensureVendorPrice(in2CareId, 'SiteOne', 13.14, '1 station', 'station');
  await ensureVendorPrice(dunkId, 'Amazon', 26.88, '20 count', 'tablet');

  if (hasUsage && hasProducts) {
    const retiredMosquitoProductIds = await knex('products_catalog')
      .whereIn('name', ['Cyzmic CS', 'Tekko Pro', 'Bifen I/T', 'Tekko Pro IGR', 'Scion Insecticide'])
      .pluck('id');
    if (retiredMosquitoProductIds.length) {
      await knex('service_product_usage')
        .whereIn('service_type', [
          'Mosquito Treatment',
          'Mosquito Treatment - Essential Barrier',
          'Mosquito Treatment - IGR',
          'Mosquito Treatment - Precision Barrier',
        ])
        .whereIn('product_id', retiredMosquitoProductIds)
        .del();
    }
  }

  await ensureUsage('Mosquito Treatment - Essential Barrier', bifenId, {
    usage_amount: 3.0,
    usage_unit: 'oz',
    usage_per_1000sf: 0.5,
    is_primary: true,
    notes: '[usage:max_base_or_per_1000] Standard barrier adulticide for monthly/seasonal mosquito programs.',
  });
  await ensureUsage('Mosquito Treatment - IGR', tekkoId, {
    usage_amount: 1.0,
    usage_unit: 'oz',
    usage_per_1000sf: null,
    is_primary: false,
    notes: 'IGR added where breeding pressure exists.',
  });
  await ensureUsage('Mosquito Treatment - Precision Barrier', scionId, {
    usage_amount: 0.75,
    usage_unit: 'oz',
    usage_per_1000sf: 0.125,
    is_primary: true,
    notes: '[usage:base_plus_per_1000] Precision barrier option using gamma-cyhalothrin adulticide.',
  });
  await ensureUsage('Mosquito Treatment - Stations', in2CareId, {
    usage_amount: 1,
    usage_unit: 'station',
    usage_per_1000sf: null,
    is_primary: false,
    notes: 'Optional mosquito station add-on.',
  });
  await ensureUsage('Mosquito Treatment - Dunks', dunkId, {
    usage_amount: 1,
    usage_unit: 'tablet',
    usage_per_1000sf: null,
    is_primary: false,
    notes: 'Optional standing-water Bti dunk add-on.',
  });

  if (await knex.schema.hasTable('pricing_config')) {
    const mosquitoBasePrices = {
      SMALL: { seasonal: 105, monthly: 90, residual_seasonal: 135, residual_monthly: 120 },
      QUARTER: { seasonal: 115, monthly: 100, residual_seasonal: 150, residual_monthly: 135 },
      THIRD: { seasonal: 130, monthly: 115, residual_seasonal: 175, residual_monthly: 155 },
      HALF: { seasonal: 155, monthly: 135, residual_seasonal: 210, residual_monthly: 185 },
      ACRE: { seasonal: 195, monthly: 175, residual_seasonal: 265, residual_monthly: 235 },
    };
    const mosquitoVisits = { seasonal: 9, monthly: 12, residual_seasonal: 9, residual_monthly: 12 };
    const onetimeMosquito = { SMALL: 225, QUARTER: 275, THIRD: 325, HALF: 385, ACRE: 475 };

    await knex('pricing_config').where({ config_key: 'mosquito_base_prices' }).update({
      name: 'Mosquito Program Per-Visit Pricing',
      data: JSON.stringify(mosquitoBasePrices),
      updated_at: knex.fn.now(),
    });
    await knex('pricing_config').where({ config_key: 'mosquito_visits' }).update({
      name: 'Mosquito Visits by Program',
      data: JSON.stringify(mosquitoVisits),
      updated_at: knex.fn.now(),
    });
    await knex('pricing_config').where({ config_key: 'onetime_mosquito' }).update({
      data: JSON.stringify(onetimeMosquito),
      updated_at: knex.fn.now(),
    });
  }

  if (await knex.schema.hasTable('services')) {
    await knex('services').where({ service_key: 'mosquito_monthly' }).update({
      description: 'Gas-powered backpack barrier treatment to foliage, eaves, and breeding sites. Essential program uses bifenthrin plus pyriproxyfen + novaluron IGR where breeding pressure exists; Precision Barrier uses gamma-cyhalothrin. Station add-ons are available.',
      base_price: 90,
      price_range_min: 79,
      price_range_max: 235,
      default_products: JSON.stringify(['Bifen I/T', 'Tekko Pro IGR', 'Scion Insecticide', 'In2Care Mosquito Station', 'Summit Mosquito Dunk Tablets']),
      updated_at: knex.fn.now(),
    });
    await knex('services').where({ service_key: 'mosquito_event' }).update({
      base_price: 225,
      price_range_min: 225,
      price_range_max: 475,
      default_products: JSON.stringify(['Bifen I/T', 'Tekko Pro IGR', 'Summit Mosquito Dunk Tablets']),
      updated_at: knex.fn.now(),
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('service_product_usage')) {
    await knex('service_product_usage')
      .whereIn('service_type', [
        'Mosquito Treatment - Essential Barrier',
        'Mosquito Treatment - IGR',
        'Mosquito Treatment - Precision Barrier',
        'Mosquito Treatment - Stations',
        'Mosquito Treatment - Dunks',
      ])
      .del();
  }

  if (await knex.schema.hasTable('pricing_config')) {
    await knex('pricing_config').where({ config_key: 'mosquito_base_prices' }).update({
      data: JSON.stringify({
        SMALL: { bronze: 80, silver: 90, gold: 100, platinum: 110 },
        QUARTER: { bronze: 90, silver: 100, gold: 115, platinum: 125 },
        THIRD: { bronze: 100, silver: 110, gold: 125, platinum: 135 },
        HALF: { bronze: 110, silver: 125, gold: 145, platinum: 155 },
        ACRE: { bronze: 140, silver: 155, gold: 180, platinum: 200 },
      }),
      updated_at: knex.fn.now(),
    });
    await knex('pricing_config').where({ config_key: 'mosquito_visits' }).update({
      data: JSON.stringify({ bronze: 12, silver: 12, gold: 15, platinum: 17 }),
      updated_at: knex.fn.now(),
    });
    await knex('pricing_config').where({ config_key: 'onetime_mosquito' }).update({
      data: JSON.stringify({ SMALL: 200, QUARTER: 250, THIRD: 275, HALF: 300, ACRE: 350 }),
      updated_at: knex.fn.now(),
    });
  }
};
