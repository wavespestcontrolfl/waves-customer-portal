/**
 * Align palm injection pricing_config with the protocol-based May 2026 PALM
 * constants. Legacy scalar keys are intentionally removed so DB sync cannot
 * override tiered combo/insecticide and fungal floor pricing with old values.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await knex('pricing_config')
    .insert({
      config_key: 'palm_pricing',
      name: 'Palm Injection Protocol Pricing',
      category: 'palm',
      sort_order: 1,
      data: JSON.stringify({
        nutrition: 35,
        insecticide_small: 45,
        insecticide_medium: 55,
        insecticide_large: 75,
        combo_small: 65,
        combo_medium: 75,
        combo_large: 95,
        fungal_floor: 50,
        lethal_bronzing_floor: 125,
        tree_age_floor: 65,
        min_per_visit: 75,
        nutrition_default_apps_per_year: 1,
        nutrition_allowed_apps_per_year: [1, 2],
        flat_credit_per_palm: 10,
        flat_credit_min_tier: 'gold',
        tier_qualifier: false,
        exclude_from_pct_discount: true,
      }),
      updated_at: knex.fn.now(),
    })
    .onConflict('config_key')
    .merge(['name', 'category', 'sort_order', 'data', 'updated_at']);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await knex('pricing_config')
    .insert({
      config_key: 'palm_pricing',
      name: 'Palm Injection Tiered Pricing',
      category: 'palm',
      sort_order: 1,
      data: JSON.stringify({
        nutrition: 35,
        preventive_insecticide: 45,
        combo: 55,
        fungal: 40,
        lethal_bronzing_floor: 125,
        tree_age_floor: 65,
        min_per_visit: 75,
        apps_per_year: 2,
        tier_qualifier: false,
        flat_credit_per_palm: 10,
        flat_credit_min_tier: 'gold',
      }),
      updated_at: knex.fn.now(),
    })
    .onConflict('config_key')
    .merge(['name', 'category', 'sort_order', 'data', 'updated_at']);
};
