const PEST_FOOTPRINT = {
  breakpoints: [
    { sqft: 800, adj: -15 },
    { sqft: 1200, adj: -10 },
    { sqft: 1500, adj: -5 },
    { sqft: 2000, adj: 0 },
    { sqft: 2500, adj: 3 },
    { sqft: 3000, adj: 6 },
    { sqft: 4000, adj: 10 },
    { sqft: 5500, adj: 16 },
  ],
};

const PEST_FEATURES = {
  indoor: 15,
  pool_cage: 8,
  pool_cage_small: 5,
  pool_cage_medium: 8,
  pool_cage_large: 12,
  pool_cage_oversized: 18,
  pool_no_cage: 0,
  shrubs_heavy: 6,
  shrubs_moderate: 0,
  shrubs_light: -5,
  trees_heavy: 6,
  trees_moderate: 0,
  trees_light: -5,
  landscape_simple: -5,
  landscape_moderate: 0,
  landscape_complex: 3,
  near_water: 3,
  large_driveway: 3,
};

const PREVIOUS_FOOTPRINT = {
  breakpoints: [
    { sqft: 800, adj: -15 },
    { sqft: 1200, adj: -10 },
    { sqft: 1500, adj: -5 },
    { sqft: 2000, adj: 0 },
    { sqft: 2500, adj: 8 },
    { sqft: 3000, adj: 14 },
    { sqft: 4000, adj: 21 },
    { sqft: 5500, adj: 31 },
  ],
};

const PREVIOUS_FEATURES = {
  indoor: 15,
  pool_cage: 10,
  pool_no_cage: 5,
  shrubs_heavy: 12,
  shrubs_moderate: 5,
  trees_heavy: 12,
  trees_moderate: 5,
  landscape_simple: -5,
  landscape_moderate: 0,
  landscape_complex: 5,
  near_water: 5,
  large_driveway: 5,
};

async function upsertConfig(knex, configKey, name, category, sortOrder, data) {
  const existing = await knex('pricing_config').where({ config_key: configKey }).first('id');
  const payload = {
    name,
    category,
    sort_order: sortOrder,
    data: JSON.stringify(data),
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('pricing_config').where({ config_key: configKey }).update(payload);
  } else {
    await knex('pricing_config').insert({
      config_key: configKey,
      ...payload,
      created_at: knex.fn.now(),
    });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, 'pest_footprint', 'Pest Footprint Modifiers', 'pest', 2, PEST_FOOTPRINT);
  await upsertConfig(knex, 'pest_features', 'Pest Feature Modifiers', 'pest', 3, PEST_FEATURES);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await upsertConfig(knex, 'pest_footprint', 'Pest Footprint Modifiers', 'pest', 2, PREVIOUS_FOOTPRINT);
  await upsertConfig(knex, 'pest_features', 'Pest Feature Modifiers', 'pest', 3, PREVIOUS_FEATURES);
};
