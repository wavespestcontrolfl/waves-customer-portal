/**
 * Recalibrate recurring lawn pricing from the 55% fully loaded floor to a
 * 45% fully loaded floor, restoring the pre-55 bracket curve as market price.
 */

const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.45,
  laborRateLoaded: 35,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: { DENSE: 5, NORMAL: 10, LOOSE: 15, SPARSE: 20 },
  pricingMode: 'FORTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_45_FLOOR',
};

const BRACKETS_45 = {
  st_augustine: [
    [0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],
    [5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],
    [10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250],
  ],
  bermuda: [
    [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],
    [7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],
    [15000,65,88,132,199],[20000,81,111,169,256],
  ],
  zoysia: [
    [0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],
    [7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],
    [15000,66,89,134,202],[20000,83,112,171,259],
  ],
  bahia: [
    [0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],
    [5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],
    [10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223],
  ],
};

const BRACKETS_55 = {
  st_augustine: [
    [0,39,52,76,100],[3000,39,52,76,100],[3500,41,55,80,106],[4000,43,57,84,111],
    [5000,47,63,92,123],[6000,51,68,100,135],[7000,54,73,109,146],[8000,58,78,117,158],
    [10000,65,88,133,182],[12000,73,98,150,205],[15000,84,113,175,240],[20000,102,138,216,298],
  ],
  bermuda: [
    [0,42,57,84,113],[4000,42,57,84,113],[5000,45,62,92,125],[6000,48,67,100,137],
    [7000,52,71,108,149],[8000,55,76,117,161],[10000,62,86,133,186],[12000,68,96,149,210],
    [15000,78,110,174,246],[20000,95,135,215,307],
  ],
  zoysia: [
    [0,42,57,85,107],[4000,42,57,85,107],[5000,46,62,94,118],[6000,50,67,102,128],
    [7000,53,72,111,139],[8000,57,77,119,149],[10000,64,87,136,170],[12000,71,97,153,192],
    [15000,81,112,179,223],[20000,99,137,221,276],
  ],
  bahia: [
    [0,37,51,70,89],[3000,37,51,70,89],[3500,38,53,73,93],[4000,40,55,76,97],
    [5000,43,59,83,105],[6000,46,64,89,113],[7000,49,68,95,121],[8000,52,73,102,129],
    [10000,58,82,114,144],[12000,63,90,127,160],[15000,72,104,146,184],[20000,87,126,178,224],
  ],
};

const TIERS = ['basic', 'standard', 'enhanced', 'premium'];

async function applyBrackets(knex, brackets) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;
  for (const [track, rows] of Object.entries(brackets)) {
    for (const row of rows) {
      const sqft = row[0];
      for (let i = 0; i < TIERS.length; i += 1) {
        await knex('lawn_pricing_brackets')
          .where({ grass_track: track, sqft_bracket: sqft, tier: TIERS[i] })
          .update({ monthly_price: row[i + 1], updated_at: knex.fn.now() });
      }
    }
  }
}

async function updateServices(knex, values) {
  if (!(await knex.schema.hasTable('services'))) return;
  for (const { service_key, base_price } of values) {
    await knex('services')
      .where({ service_key })
      .update({ base_price, updated_at: knex.fn.now() });
  }
}

async function insertChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'codex-2026-05-30',
    category: 'rule',
    summary: 'Recalibrate recurring lawn pricing to a 45% fully loaded floor.',
  };

  const existing = await knex('pricing_changelog')
    .where(identity)
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify(['lawn_care', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      lawn_pricing_v2: {
        targetCollectedMarginFloor: 0.55,
        pricingMode: 'FIFTY_FIVE_MARGIN_FLOOR',
      },
      baseline_source: 'DB-synced regression baseline pinned to the 55% lawn floor.',
    }),
    after_value: JSON.stringify({
      lawn_pricing_v2: LAWN_PRICING_V2,
      baseline_source: 'DB-synced and source-only lawn-inclusive regression cases recaptured for the 45% floor.',
    }),
    rationale: 'Recurring lawn pricing should treat 45% as the minimum fully loaded floor, while 50-55% remains the healthy gross-margin target. The prior 55% floor over-priced small recurring lawn accounts, including the 2,870 sq ft estimate reviewed on 2026-05-30.',
  });
}

async function removeChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-30',
      category: 'rule',
      summary: 'Recalibrate recurring lawn pricing to a 45% fully loaded floor.',
    })
    .del();
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const hasIsActive = await knex.schema.hasColumn('pricing_config', 'is_active');
    const insertRow = {
      config_key: 'lawn_pricing_v2',
      name: 'Lawn Pricing V2 Dense 45% Floor',
      category: 'lawn',
      data: JSON.stringify(LAWN_PRICING_V2),
      sort_order: 4,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    };
    const mergeRow = {
      name: 'Lawn Pricing V2 Dense 45% Floor',
      data: JSON.stringify(LAWN_PRICING_V2),
      updated_at: knex.fn.now(),
    };
    if (hasIsActive) {
      insertRow.is_active = true;
      mergeRow.is_active = true;
    }
    await knex('pricing_config')
      .insert(insertRow)
      .onConflict('config_key')
      .merge(mergeRow);
  }

  await applyBrackets(knex, BRACKETS_45);
  await updateServices(knex, [
    { service_key: 'lawn_care_quarterly', base_price: 35.00 },
    { service_key: 'lawn_care_recurring', base_price: 45.00 },
    { service_key: 'lawn_care_6week', base_price: 55.00 },
    { service_key: 'lawn_care_monthly', base_price: 65.00 },
  ]);
  await insertChangelog(knex);
};

exports.down = async function down(knex) {
  await removeChangelog(knex);

  if (await knex.schema.hasTable('pricing_config')) {
    await knex('pricing_config')
      .where({ config_key: 'lawn_pricing_v2' })
      .update({
        name: 'Lawn Pricing V2 Dense 55% Floor',
        data: JSON.stringify({
          ...LAWN_PRICING_V2,
          targetCollectedMarginFloor: 0.55,
          pricingMode: 'FIFTY_FIVE_MARGIN_FLOOR',
          pricingVersion: 'LAWN_PRICING_V2_DENSE_55_FLOOR',
        }),
        updated_at: knex.fn.now(),
      });
  }

  await applyBrackets(knex, BRACKETS_55);
  await updateServices(knex, [
    { service_key: 'lawn_care_quarterly', base_price: 42.00 },
    { service_key: 'lawn_care_recurring', base_price: 56.00 },
    { service_key: 'lawn_care_6week', base_price: 82.00 },
    { service_key: 'lawn_care_monthly', base_price: 109.00 },
  ]);
};
