const LAWN_PRICING_V2 = {
  targetCollectedMarginFloor: 0.55,
  targetListMargin: null,
  useTargetListMargin: false,
  pricingMode: 'FIFTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_55_FLOOR',
  laborRateLoaded: 35,
  equipmentIncludedInLabor: true,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: {
    DENSE: 5,
    NORMAL: 10,
    LOOSE: 15,
    SPARSE: 20,
  },
  tiers: {
    standard: { label: 'Standard', applicationsPerYear: 6, customerFacing: true },
    enhanced: { label: 'Enhanced', applicationsPerYear: 9, customerFacing: true, default: true },
    premium: { label: 'Premium', applicationsPerYear: 12, customerFacing: true },
    basic: { label: 'Basic', applicationsPerYear: 4, customerFacing: true, hidden: false },
  },
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await knex('pricing_config')
    .insert({
      config_key: 'lawn_pricing_v2',
      name: 'Lawn Pricing V2 Dense 55% Floor',
      category: 'lawn',
      sort_order: 1,
      data: JSON.stringify(LAWN_PRICING_V2),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict('config_key')
    .merge(['name', 'category', 'sort_order', 'data', 'updated_at']);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).del();
};
