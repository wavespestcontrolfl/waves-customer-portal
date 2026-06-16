const LAWN_PRICING_V2_CUSTOMER_TIERS = {
  basic: { label: 'Basic', applicationsPerYear: 4, customerFacing: true, hidden: false },
  standard: { label: 'Standard', applicationsPerYear: 6, customerFacing: true },
  enhanced: { label: 'Enhanced', applicationsPerYear: 9, customerFacing: true, default: true },
  premium: { label: 'Premium', applicationsPerYear: 12, customerFacing: true },
};

const LAWN_PRICING_V2_BASE = {
  targetCollectedMarginFloor: 0.45,
  pricingMode: 'FORTY_FIVE_MARGIN_FLOOR',
  pricingVersion: 'LAWN_PRICING_V2_DENSE_45_FLOOR',
  laborRateLoaded: 35,
  equipmentReservePerVisit: 0,
  adminAnnualDefault: 51,
  callbackReservePerVisitDefault: 2,
  laborMinutesBase: 12,
  laborMinutesPer1000Sqft: 2.5,
  defaultRouteDensity: 'DENSE',
  routeDensityMinutes: { DENSE: 5, NORMAL: 10, LOOSE: 15, SPARSE: 20 },
};

function parseConfigData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

async function upsertLawnPricingConfig(knex, data) {
  const hasIsActive = await knex.schema.hasColumn('pricing_config', 'is_active');
  const row = {
    name: 'Lawn Pricing V2 Dense 45% Floor',
    category: 'lawn',
    sort_order: 4,
    data: JSON.stringify(data),
    updated_at: knex.fn.now(),
  };
  if (hasIsActive) row.is_active = true;
  const mergeFields = ['name', 'category', 'sort_order', 'data', 'updated_at'];
  if (hasIsActive) mergeFields.push('is_active');

  await knex('pricing_config')
    .insert({
      config_key: 'lawn_pricing_v2',
      ...row,
      created_at: knex.fn.now(),
    })
    .onConflict('config_key')
    .merge(mergeFields);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const existing = await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .first('data');
  const existingData = parseConfigData(existing?.data);

  await upsertLawnPricingConfig(knex, {
    ...LAWN_PRICING_V2_BASE,
    ...existingData,
    tiers: {
      ...(existingData.tiers || {}),
      ...LAWN_PRICING_V2_CUSTOMER_TIERS,
    },
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const existing = await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .first('data');
  if (!existing) return;

  const existingData = parseConfigData(existing.data);
  await upsertLawnPricingConfig(knex, {
    ...LAWN_PRICING_V2_BASE,
    ...existingData,
    tiers: {
      ...(existingData.tiers || {}),
      basic: { label: 'Basic', applicationsPerYear: 4, customerFacing: false, hidden: true },
      standard: { label: 'Standard', applicationsPerYear: 6, customerFacing: true },
      enhanced: { label: 'Enhanced', applicationsPerYear: 9, customerFacing: true, default: true },
      premium: { label: 'Premium', applicationsPerYear: 12, customerFacing: true },
    },
  });
};
