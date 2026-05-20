const PRE_SLAB_TERMITICIDE = {
  default_product_key: 'termidor_sc',
  ps_equip: 15,
  warranty_extended: 200,
  volume_discounts: { none: 1.00, '5plus': 0.90, '10plus': 0.85 },
  products: {
    termidor_sc: {
      container_cost: 174.72,
      container_oz: 78,
      product_oz_per_10_sqft: 0.8,
      margin_divisor: 0.45,
      floor_before_volume_discount: 600,
      floor_after_volume_discount: 500,
    },
    taurus_sc: {
      container_cost: 95.00,
      container_oz: 78,
      product_oz_per_10_sqft: 0.8,
      margin_divisor: 0.45,
      floor_before_volume_discount: 600,
      floor_after_volume_discount: 500,
    },
    bifen_it: {
      container_cost: 41.53,
      container_oz: 128,
      product_oz_per_10_sqft: 1.0,
      margin_divisor: 0.45,
      floor_before_volume_discount: 600,
      floor_after_volume_discount: 500,
    },
    talstar_p: {
      container_cost: 38.99,
      container_oz: 128,
      product_oz_per_10_sqft: 1.0,
      margin_divisor: 0.45,
      floor_before_volume_discount: 600,
      floor_after_volume_discount: 500,
    },
  },
};

const LEGACY_PRE_SLAB_TERMIDOR = {
  ps_btl: 174.72,
  ps_cov: 1250,
  ps_equip: 15,
  warranty_extended: 206,
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
  merged.volume_discounts = {
    ...(defaults.volume_discounts || {}),
    ...(current.volume_discounts || {}),
  };

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
  const legacy = { ...LEGACY_PRE_SLAB_TERMIDOR, ...current };
  delete legacy.default_product_key;
  delete legacy.products;
  if (!legacy.volume_discounts && current.volume_discounts) {
    legacy.volume_discounts = current.volume_discounts;
  }
  return legacy;
}

async function upsertConfig(knex, data, name = 'Pre-Slab Termiticide Treatment') {
  const existing = await knex('pricing_config')
    .where({ config_key: 'onetime_preslab' })
    .first('id', 'data');
  const currentData = parseConfigData(existing?.data);
  const nextData = data === PRE_SLAB_TERMITICIDE
    ? mergeConfigDefaults(data, currentData)
    : legacyConfigFromCurrent(currentData);
  const payload = {
    name,
    category: 'one_time',
    sort_order: 8,
    data: JSON.stringify(nextData),
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('pricing_config').where({ config_key: 'onetime_preslab' }).update(payload);
    return;
  }
  await knex('pricing_config').insert({
    config_key: 'onetime_preslab',
    ...payload,
    created_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, PRE_SLAB_TERMITICIDE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, LEGACY_PRE_SLAB_TERMIDOR, 'Pre-Slab Termidor');
};
