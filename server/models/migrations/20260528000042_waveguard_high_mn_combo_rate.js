const VERIFIED_AT = new Date('2026-05-28T00:00:00.000Z');
const VERIFIED_BY = 'waveguard-high-mn-combo-rate-seed-2026-05-28';

const PRODUCT_NAME = 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer';

const PRODUCT_FIELDS = {
  category: 'fertilizer',
  active_ingredient: 'Micronutrients: 1% Mg, 5.75% S, 3% Fe, 4% Mn',
  formulation: 'liquid',
  container_size: '2.5 gal',
  unit_size_oz: 320,
  best_price: 215.50,
  cost_per_unit: 0.6734,
  cost_unit: 'fl_oz',
  default_rate_per_1000: 0.1975,
  min_label_rate_per_1000: 0.1975,
  max_label_rate_per_1000: 0.1975,
  rate_unit: 'fl_oz',
  mixing_order_category: 'liquid_fertilizer',
  irrigation_required: false,
  needs_pricing: false,
  label_source_note: 'Seeded from WaveGuard protocol audit: public bid pricing lists High Manganese Combo at $215.50 per 2.5 gal, and the current protocol allowance is $1.33 per 10,000 sq ft. This yields a planning rate of 0.1975 fl oz/1,000 sq ft until final label calibration is verified.',
};

function updateFields(knex) {
  return {
    ...PRODUCT_FIELDS,
    updated_at: knex.fn.now(),
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  const existing = await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [PRODUCT_NAME])
    .first();

  if (existing) {
    await knex('products_catalog')
      .where({ id: existing.id })
      .update(updateFields(knex));
    return;
  }

  await knex('products_catalog').insert({
    name: PRODUCT_NAME,
    active: true,
    customer_visibility: 'internal_only',
    content_status: 'draft',
    ...PRODUCT_FIELDS,
    label_verified_at: VERIFIED_AT,
    label_verified_by: VERIFIED_BY,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [PRODUCT_NAME])
    .where({ label_verified_by: VERIFIED_BY })
    .del();

  await knex('products_catalog')
    .whereRaw('LOWER(name) = LOWER(?)', [PRODUCT_NAME])
    .update({
      best_price: null,
      cost_per_unit: null,
      cost_unit: null,
      default_rate_per_1000: null,
      min_label_rate_per_1000: null,
      max_label_rate_per_1000: null,
      rate_unit: null,
      label_source_note: null,
      needs_pricing: true,
      updated_at: knex.fn.now(),
    });
};
