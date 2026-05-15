/**
 * Align mosquito and one-time treatment pricing_config with the May 15
 * estimator rules. Runtime constants use these same values; db-bridge can
 * load them so admin edits do not drift from the engine.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const rows = [
    {
      config_key: 'mosquito_base_prices',
      name: 'Mosquito Program Per-Visit Pricing',
      category: 'mosquito',
      sort_order: 2,
      data: JSON.stringify({
        SMALL: { seasonal9: 105, monthly12: 90 },
        QUARTER: { seasonal9: 115, monthly12: 100 },
        THIRD: { seasonal9: 130, monthly12: 115 },
        HALF: { seasonal9: 155, monthly12: 135 },
        ACRE: { seasonal9: 195, monthly12: 175 },
      }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'mosquito_visits',
      name: 'Mosquito Program Visits',
      category: 'mosquito',
      sort_order: 3,
      data: JSON.stringify({ seasonal9: 9, monthly12: 12 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_pest',
      name: 'One-Time Pest Pricing',
      category: 'one_time',
      sort_order: 3,
      data: JSON.stringify({ floor: 199, multiplier: 1.75 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_lawn',
      name: 'One-Time Lawn Treatment',
      category: 'one_time',
      sort_order: 4,
      data: JSON.stringify({
        floor: 115,
        fungicide_floor: 115,
        recurringPerAppMultiplier: 1.50,
        treatment_multipliers: {
          fert: 1.00,
          fertilization: 1.00,
          weed: 1.12,
          pest: 1.30,
          fungicide: 1.38,
        },
      }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_recurring_discount',
      name: 'Recurring Customer Discount',
      category: 'one_time',
      sort_order: 2,
      data: JSON.stringify({ discount: 0.15, note: '15% off one-time services for recurring customers' }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_mosquito',
      name: 'One-Time Mosquito Treatment',
      category: 'one_time',
      sort_order: 5,
      data: JSON.stringify({
        SMALL: 225,
        STANDARD: 275,
        LARGE: 325,
        XL: 385,
        ESTATE: 425,
        ACRE_CLASS: 475,
        OVER_ACRE: 475,
        overAcreIncrementSqFt: 10000,
        overAcreIncrementPrice: 75,
        stationAddOn: 75,
        dunkAddOn: 15,
      }),
      updated_at: knex.fn.now(),
    },
  ];

  for (const row of rows) {
    await knex('pricing_config')
      .insert(row)
      .onConflict('config_key')
      .merge(['name', 'category', 'sort_order', 'data', 'updated_at']);
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const rows = [
    {
      config_key: 'mosquito_base_prices',
      name: 'Mosquito Program Per-Visit Pricing',
      category: 'mosquito',
      sort_order: 2,
      data: JSON.stringify({
        SMALL: { seasonal: 105, monthly: 90, residual_seasonal: 135, residual_monthly: 120 },
        QUARTER: { seasonal: 115, monthly: 100, residual_seasonal: 150, residual_monthly: 135 },
        THIRD: { seasonal: 130, monthly: 115, residual_seasonal: 175, residual_monthly: 155 },
        HALF: { seasonal: 155, monthly: 135, residual_seasonal: 210, residual_monthly: 185 },
        ACRE: { seasonal: 195, monthly: 175, residual_seasonal: 265, residual_monthly: 235 },
      }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'mosquito_visits',
      name: 'Mosquito Visits by Program',
      category: 'mosquito',
      sort_order: 3,
      data: JSON.stringify({ seasonal: 9, monthly: 12, residual_seasonal: 9, residual_monthly: 12 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_pest',
      name: 'One-Time Pest Pricing',
      category: 'one_time',
      sort_order: 3,
      data: JSON.stringify({ floor: 150, multiplier: 1.30 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_lawn',
      name: 'One-Time Lawn Treatment',
      category: 'one_time',
      sort_order: 4,
      data: JSON.stringify({ floor: 85, fungicide_floor: 95, weed_mult: 1.15, fungicide_mult: 1.45 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_recurring_discount',
      name: 'Recurring Customer Discount',
      category: 'one_time',
      sort_order: 2,
      data: JSON.stringify({ multiplier: 0.85 }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_mosquito',
      name: 'One-Time Mosquito Pricing',
      category: 'one_time',
      sort_order: 5,
      data: JSON.stringify({ SMALL: 225, QUARTER: 275, THIRD: 325, HALF: 385, ACRE: 475 }),
      updated_at: knex.fn.now(),
    },
  ];

  for (const row of rows) {
    await knex('pricing_config')
      .insert(row)
      .onConflict('config_key')
      .merge(['name', 'category', 'sort_order', 'data', 'updated_at']);
  }
};
