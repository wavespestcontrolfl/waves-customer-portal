exports.up = async function(knex) {
  const hasPricingConfig = await knex.schema.hasTable('pricing_config');
  if (hasPricingConfig) {
    await knex('pricing_config')
      .where({ config_key: 'rodent_trapping' })
      .update({
        name: 'Rodent Trapping (active-window checks included)',
        data: JSON.stringify({
          base: 395,
          floor: 350,
          ceiling_before_custom: 795,
          included_followups: 'unlimited',
          active_window_days: 14,
          additional_followup_rate: 0,
          emergency_multiplier: 1.20,
          emergency_minimum_surcharge: 75,
          home_size_adjustments: [
            { max_sqft: 1200, adjustment: -25 },
            { max_sqft: 2500, adjustment: 0 },
            { max_sqft: 4000, adjustment: 50 },
            { max_sqft: 6000, adjustment: 95 },
            { max_sqft: 'Infinity', adjustment: 150, custom_recommended: true },
          ],
          lot_adjustments: [
            { max_lot_sqft: 10000, adjustment: 0 },
            { max_lot_sqft: 20000, adjustment: 35 },
            { max_lot_sqft: 43560, adjustment: 75 },
            { max_lot_sqft: 'Infinity', adjustment: 125, custom_recommended: true },
          ],
          pressure_adjustments: { light: -25, normal: 0, moderate: 35, heavy: 75, severe: 150 },
        }),
        updated_at: knex.fn.now(),
      });

    await knex('pricing_config')
      .whereIn('config_key', ['rodent_waveguard', 'rodent_rules'])
      .update({
        data: knex.raw(
          "jsonb_set(COALESCE(data::jsonb, '{}'::jsonb), '{setup_credit}', '0'::jsonb, true)"
        ),
        updated_at: knex.fn.now(),
      });
  }

  const hasServices = await knex.schema.hasTable('services');
  if (hasServices) {
    await knex('services')
      .where('service_key', 'rodent_trapping')
      .update({
        description: 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup and unlimited trap checks/callbacks during the 14-day active trapping window.',
        updated_at: knex.fn.now(),
      });

    await knex('services')
      .where('service_key', 'rodent_trapping_exclusion_sanitation')
      .update({
        description: 'Complete rodent remediation: trapping with active-window trap checks, full exclusion sealing (per-point), and sanitation. 10% bundle discount when it lowers the component total. Eligible for $199-$299/yr guarantee renewal.',
        updated_at: knex.fn.now(),
      });
  }

  const hasServiceDiscountRules = await knex.schema.hasTable('service_discount_rules');
  if (hasServiceDiscountRules) {
    await knex('service_discount_rules')
      .where({ service_key: 'rodent_bait' })
      .update({
        tier_qualifier: false,
        exclude_from_pct_discount: true,
        flat_credit: null,
        flat_credit_min_tier: null,
        notes: 'Fully excluded from WaveGuard credits, coupons, setup credits, discounts, and tier benefits.',
        updated_at: knex.fn.now(),
      });
  }
};

exports.down = async function(knex) {
  const hasPricingConfig = await knex.schema.hasTable('pricing_config');
  if (hasPricingConfig) {
    await knex('pricing_config')
      .where({ config_key: 'rodent_trapping' })
      .update({
        name: 'Rodent Trapping (setup + 2 follow-ups)',
        data: JSON.stringify({
          base: 395,
          floor: 350,
          ceiling_before_custom: 795,
          included_followups: 2,
          additional_followup_rate: 95,
          emergency_multiplier: 1.20,
          emergency_minimum_surcharge: 75,
          home_size_adjustments: [
            { max_sqft: 1200, adjustment: -25 },
            { max_sqft: 2500, adjustment: 0 },
            { max_sqft: 4000, adjustment: 50 },
            { max_sqft: 6000, adjustment: 95 },
            { max_sqft: 'Infinity', adjustment: 150, custom_recommended: true },
          ],
          lot_adjustments: [
            { max_lot_sqft: 10000, adjustment: 0 },
            { max_lot_sqft: 20000, adjustment: 35 },
            { max_lot_sqft: 43560, adjustment: 75 },
            { max_lot_sqft: 'Infinity', adjustment: 125, custom_recommended: true },
          ],
          pressure_adjustments: { light: -25, normal: 0, moderate: 35, heavy: 75, severe: 150 },
        }),
        updated_at: knex.fn.now(),
      });

    await knex('pricing_config')
      .whereIn('config_key', ['rodent_waveguard', 'rodent_rules'])
      .update({
        data: knex.raw(
          "jsonb_set(COALESCE(data::jsonb, '{}'::jsonb), '{setup_credit}', '50'::jsonb, true)"
        ),
        updated_at: knex.fn.now(),
      });
  }

  const hasServiceDiscountRules = await knex.schema.hasTable('service_discount_rules');
  if (hasServiceDiscountRules) {
    await knex('service_discount_rules')
      .where({ service_key: 'rodent_bait' })
      .update({
        tier_qualifier: false,
        exclude_from_pct_discount: true,
        flat_credit: null,
        flat_credit_min_tier: null,
        notes: 'Excluded from % discounts. $50 setup credit handled separately.',
        updated_at: knex.fn.now(),
      });
  }
};
