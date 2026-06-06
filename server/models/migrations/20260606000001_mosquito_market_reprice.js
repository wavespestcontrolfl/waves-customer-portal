/**
 * Reprice mosquito (recurring + one-time) to the SW-FL market band.
 *
 * Mosquito pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.mosquito_base_prices` and `onetime_mosquito` over the
 * in-code constants at startup. The constants.js reprice is therefore inert
 * in any env carrying these rows unless we also update the DB. This migration
 * brings both rows in line with the new constants (and the refreshed
 * admin-pricing-config seed defaults).
 *
 * New per-visit [seasonal9, monthly12]: SMALL 66/60, QUARTER 69/63,
 * THIRD 72/66, HALF 78/70, ACRE 88/78. One-time: 99/129/159/199/239/269,
 * over-acre increment 75 -> 40.
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
        SMALL: { seasonal9: 66, monthly12: 60 },
        QUARTER: { seasonal9: 69, monthly12: 63 },
        THIRD: { seasonal9: 72, monthly12: 66 },
        HALF: { seasonal9: 78, monthly12: 70 },
        ACRE: { seasonal9: 88, monthly12: 78 },
      }),
      updated_at: knex.fn.now(),
    },
    {
      config_key: 'onetime_mosquito',
      name: 'One-Time Mosquito Treatment',
      category: 'one_time',
      sort_order: 5,
      data: JSON.stringify({
        SMALL: 99,
        STANDARD: 129,
        LARGE: 159,
        XL: 199,
        ESTATE: 239,
        ACRE_CLASS: 269,
        OVER_ACRE: 269,
        overAcreIncrementSqFt: 10000,
        overAcreIncrementPrice: 40,
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

  // Record the intentional pricing/baseline change.
  if (await knex.schema.hasTable('pricing_changelog')) {
    const identity = {
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'claude-2026-06-06',
      category: 'rule',
      summary: 'Reprice mosquito (recurring + one-time) to SW-FL market band.',
    };
    const existing = await knex('pricing_changelog').where(identity).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...identity,
        affected_services: JSON.stringify(['mosquito', 'one_time_mosquito']),
        before_value: JSON.stringify({
          mosquito_base_prices: { SMALL: [105, 90], QUARTER: [115, 100], THIRD: [130, 115], HALF: [155, 135], ACRE: [195, 175] },
          onetime_mosquito: { SMALL: 225, STANDARD: 275, LARGE: 325, XL: 385, ESTATE: 425, ACRE_CLASS: 475, OVER_ACRE: 475, overAcreIncrementPrice: 75 },
        }),
        after_value: JSON.stringify({
          mosquito_base_prices: { SMALL: [66, 60], QUARTER: [69, 63], THIRD: [72, 66], HALF: [78, 70], ACRE: [88, 78] },
          onetime_mosquito: { SMALL: 99, STANDARD: 129, LARGE: 159, XL: 199, ESTATE: 239, ACRE_CLASS: 269, OVER_ACRE: 269, overAcreIncrementPrice: 40 },
        }),
        rationale: 'Mosquito ran ~2x the SW-FL market ($45-58/mo recurring, $80-150 one-time) and effectively never sold (3 of 228 estimates attached it, 0 accepted). Repriced into the market band; real margin stays ~62-71% recurring / ~80%+ one-time (Bifen-only barrier, ~11min on-site). Multipliers unchanged. Local regression baselines + the pure-mosquito DB baseline cases refreshed in the same PR; the prod-divergent platinum-bundle DB cases (edge_large_footprint_5500sf_platinum_bundle, v1adapter_platinum_bundle_4_services_zone_a) require a post-deploy DB-parity recapture once these prices are live in prod.',
      });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog')
      .where({
        version_from: 'v4.3',
        version_to: 'v4.3',
        changed_by: 'claude-2026-06-06',
        category: 'rule',
        summary: 'Reprice mosquito (recurring + one-time) to SW-FL market band.',
      })
      .del();
  }

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
