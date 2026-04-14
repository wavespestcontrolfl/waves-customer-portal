exports.up = async function(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return; // ensureTable will seed on next API call

  // Update pest_features to include shrubs_light, trees_light, indoor
  const existing = await knex('pricing_config').where({ config_key: 'pest_features' }).first();
  if (existing) {
    const data = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    if (!('shrubs_light' in data)) data.shrubs_light = -5;
    if (!('trees_light' in data)) data.trees_light = -5;
    if (!('indoor' in data)) data.indoor = 10;
    await knex('pricing_config').where({ config_key: 'pest_features' }).update({
      data: JSON.stringify(data),
      updated_at: new Date(),
    });
  }

  // Add pest service costs config (chemical + labor breakdown)
  const costExists = await knex('pricing_config').where({ config_key: 'pest_service_costs' }).first();
  if (!costExists) {
    await knex('pricing_config').insert({
      config_key: 'pest_service_costs',
      name: 'Pest Service Cost Breakdown',
      category: 'pest',
      sort_order: 5,
      data: JSON.stringify({
        chemicals: {
          taurus_sc: { bottle_price: 95.00, bottle_oz: 78, oz_per_service: 4, cost_per_service: 4.87 },
          talak: { bottle_price: 41.57, bottle_oz: 128, oz_per_service: 4, cost_per_service: 1.30 },
        },
        labor: {
          spray_minutes: 10,
          sweep_minutes: 10,
          total_minutes: 20,
          rate_per_hour: 35,
          cost_per_service: 11.67,
        },
        total_cost_per_service: 17.84,
      }),
      description: 'Per-service chemical cost + labor time breakdown',
    });
  }
};

exports.down = async function(knex) {
  const hasTable = await knex.schema.hasTable('pricing_config');
  if (!hasTable) return;

  // Remove the new modifiers from pest_features
  const existing = await knex('pricing_config').where({ config_key: 'pest_features' }).first();
  if (existing) {
    const data = typeof existing.data === 'string' ? JSON.parse(existing.data) : existing.data;
    delete data.shrubs_light;
    delete data.trees_light;
    delete data.indoor;
    await knex('pricing_config').where({ config_key: 'pest_features' }).update({
      data: JSON.stringify(data),
      updated_at: new Date(),
    });
  }

  await knex('pricing_config').where({ config_key: 'pest_service_costs' }).del();
};
