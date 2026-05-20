const TRENCHING_PRODUCTS = {
  per_lf_dirt: 10,
  per_lf_concrete: 14,
  floor: 600,
  renewal: 325,
  default_product_key: 'taurus_sc',
  default_included_product_key: 'taurus_sc',
  default_application_rate: 'standard',
  default_trench_depth_ft: 1.0,
  finished_gallons_per_10_lf_per_ft_depth: 4,
  default_concrete_volume_pad_pct: 0.20,
  product_premium_multiplier: 1.45,
  products: {
    termidor_sc: {
      container_cost: 375.00,
      container_oz: 78,
      product_oz_per_finished_gallon_at_standard_rate: 0.8,
      product_oz_per_finished_gallon_at_high_rate: 1.6,
    },
    taurus_sc: {
      container_cost: 85.00,
      container_oz: 78,
      product_oz_per_finished_gallon_at_standard_rate: 0.8,
      product_oz_per_finished_gallon_at_high_rate: 1.6,
    },
    bifen_it: {
      container_cost: 55.00,
      container_oz: 96,
      product_oz_per_finished_gallon_at_standard_rate: 1.0,
      product_oz_per_finished_gallon_at_high_rate: 2.0,
    },
    talstar_p: {
      container_cost: 65.00,
      container_oz: 96,
      product_oz_per_finished_gallon_at_standard_rate: 1.0,
      product_oz_per_finished_gallon_at_high_rate: 2.0,
    },
  },
};

const LEGACY_TRENCHING = {
  per_lf_dirt: 10,
  per_lf_concrete: 14,
  floor: 600,
  renewal: 325,
};

function parseConfigData(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function mergeConfigDefaults(defaults, current = {}) {
  const merged = { ...defaults, ...current };
  const defaultProducts = defaults.products || {};
  const currentProducts = current.products || {};
  merged.products = { ...defaultProducts, ...currentProducts };
  for (const [key, productDefaults] of Object.entries(defaultProducts)) {
    merged.products[key] = {
      ...productDefaults,
      ...(currentProducts[key] || {}),
    };
  }
  return merged;
}

function legacyConfigFromCurrent(current = {}) {
  const legacy = { ...LEGACY_TRENCHING, ...current };
  delete legacy.default_product_key;
  delete legacy.default_included_product_key;
  delete legacy.default_application_rate;
  delete legacy.default_trench_depth_ft;
  delete legacy.finished_gallons_per_10_lf_per_ft_depth;
  delete legacy.default_concrete_volume_pad_pct;
  delete legacy.product_premium_multiplier;
  delete legacy.products;
  return legacy;
}

async function upsertConfig(knex, data) {
  const existing = await knex('pricing_config')
    .where({ config_key: 'onetime_trenching' })
    .first('id', 'data');
  const currentData = parseConfigData(existing?.data);
  const nextData = data === TRENCHING_PRODUCTS
    ? mergeConfigDefaults(data, currentData)
    : legacyConfigFromCurrent(currentData);
  const payload = {
    name: 'Trenching Rates',
    category: 'one_time',
    sort_order: 6,
    data: JSON.stringify(nextData),
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('pricing_config').where({ config_key: 'onetime_trenching' }).update(payload);
    return;
  }
  await knex('pricing_config').insert({
    config_key: 'onetime_trenching',
    ...payload,
    created_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, TRENCHING_PRODUCTS);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, LEGACY_TRENCHING);
};
