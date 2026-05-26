function pricingData(data) {
  return JSON.stringify(data);
}

async function upsertPricingConfig(knex, row) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const existing = await knex('pricing_config').where({ config_key: row.config_key }).first();
  if (existing) {
    await knex('pricing_config')
      .where({ config_key: row.config_key })
      .update({
        name: row.name,
        category: row.category,
        sort_order: row.sort_order,
        data: pricingData(row.data),
        updated_at: knex.fn.now(),
      });
    return;
  }
  await knex('pricing_config').insert({
    ...row,
    data: pricingData(row.data),
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  await upsertPricingConfig(knex, {
    config_key: 'rodent_trapping',
    name: 'Rodent Trapping',
    category: 'rodent',
    sort_order: 40,
    data: {
      standard_price: 350,
      unlimited_price: 450,
      upgrade_to_unlimited_price: 125,
      base: 350,
      floor: 350,
      unlimited_floor: 450,
      ceiling_before_custom: 795,
      included_followups: 2,
      active_window_days: null,
      additional_followup_rate: 125,
      emergency_multiplier: 1.20,
      emergency_minimum_surcharge: 75,
      home_size_adjustments: [
        { max_sqft: 1200, adjustment: 0 },
        { max_sqft: 2500, adjustment: 0 },
        { max_sqft: 4000, adjustment: 0 },
        { max_sqft: 6000, adjustment: 0 },
        { max_sqft: 'Infinity', adjustment: 0, custom_recommended: true },
      ],
      lot_adjustments: [
        { max_lot_sqft: 10000, adjustment: 0 },
        { max_lot_sqft: 20000, adjustment: 0 },
        { max_lot_sqft: 43560, adjustment: 0 },
        { max_lot_sqft: 'Infinity', adjustment: 0, custom_recommended: true },
      ],
      pressure_adjustments: { light: 0, normal: 0, moderate: 0, heavy: 0, severe: 0 },
    },
  });

  await upsertPricingConfig(knex, {
    config_key: 'rodent_trap_only_retainer',
    name: 'Trap-Only Monitoring Retainer',
    category: 'rodent',
    sort_order: 41,
    data: {
      setup_fee: 199,
      extra_callback_rate: 125,
      plans: {
        standard: {
          annual_price: 495,
          monthly_price: 49,
          scheduled_visits_included: 4,
          response_callbacks_included: 2,
        },
        plus: {
          annual_price: 695,
          monthly_price: 69,
          scheduled_visits_included: 6,
          response_callbacks_included: 3,
        },
        monthly: {
          annual_price: 995,
          monthly_price: 99,
          scheduled_visits_included: 12,
          response_callbacks_included: 2,
        },
      },
    },
  });

  await upsertPricingConfig(knex, {
    config_key: 'rodent_wire_mesh',
    name: 'Rodent Wire Mesh Linear-Foot Pricing',
    category: 'rodent',
    sort_order: 42,
    data: {
      substrates: {
        wood_soft: { rate_per_linear_foot: 14, minimum: 195 },
        concrete_masonry: { rate_per_linear_foot: 20, minimum: 250 },
        roofline_soffit_eave: { rate_per_linear_foot: 24, minimum: 275 },
        tile_steep_fragile_roofline: { rate_per_linear_foot: 24, minimum: 395, custom_quote_recommended: true },
      },
    },
  });

  await upsertPricingConfig(knex, {
    config_key: 'rodent_bird_boxes',
    name: 'Rodent Bird Boxes / Roof-Entry Covers',
    category: 'rodent',
    sort_order: 43,
    data: {
      small_bird_box: 195,
      standard_bird_box: 225,
      additional_standard_same_visit: 175,
      large_bird_box: 295,
      oversized_complex_custom: 395,
    },
  });

  if (await knex.schema.hasTable('services')) {
    await knex('services')
      .where('service_key', 'rodent_trapping')
      .update({
        base_price: 350,
        price_range_min: 350,
        price_range_max: 450,
        description: 'Standard rodent trapping includes initial setup plus 2 callbacks/checks. Unlimited Callback trapping covers callbacks for the same active trapping job only.',
        updated_at: knex.fn.now(),
      });
  }
};

exports.down = async function down(knex) {
  await upsertPricingConfig(knex, {
    config_key: 'rodent_trapping',
    name: 'Rodent Trapping (active-window checks included)',
    category: 'rodent',
    sort_order: 40,
    data: {
      base: 395,
      floor: 350,
      ceiling_before_custom: 795,
      included_followups: 'unlimited',
      active_window_days: 14,
      additional_followup_rate: 0,
      emergency_multiplier: 1.20,
      emergency_minimum_surcharge: 75,
    },
  });
};
