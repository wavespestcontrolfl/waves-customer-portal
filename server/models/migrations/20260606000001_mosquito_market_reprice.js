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
