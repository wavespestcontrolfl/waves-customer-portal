/**
 * Add Monthly / Every-6-Weeks / Quarterly variants of the Lawn Care Program.
 * Mirrors the existing bimonthly `lawn_care_recurring` entry so the Service
 * Library exposes all four cadences the pricing engine already supports
 * (LAWN_TIERS: basic=4/yr, standard=6/yr, enhanced=9/yr, premium=12/yr).
 *
 * Per-app base_price is set from the standard 4500-sqft St. Augustine
 * reference in LAWN_BRACKETS. Real pricing comes from pricing_model_key
 * 'sqft_lawn' at quote time; base_price is just the catalog anchor.
 */
const VARIANTS = [
  {
    service_key: 'lawn_care_monthly',
    short_suffix: 'Monthly',
    frequency: 'monthly',
    visits_per_year: 12,
    base_price: 65.00,
    sort_order: 8,
    internal_notes: 'Premium tier (12 rounds/yr). Pricing via sqft_lawn bracket, premium column.',
  },
  {
    service_key: 'lawn_care_6week',
    short_suffix: 'Every 6 Weeks',
    frequency: 'every_6_weeks',
    visits_per_year: 9,
    base_price: 55.00,
    sort_order: 10,
    internal_notes: 'Enhanced tier (9 rounds/yr ~ every 6 weeks). Pricing via sqft_lawn bracket, enhanced column.',
  },
  {
    service_key: 'lawn_care_quarterly',
    short_suffix: 'Quarterly',
    frequency: 'quarterly',
    visits_per_year: 4,
    base_price: 35.00,
    sort_order: 11,
    internal_notes: 'Basic tier (4 rounds/yr). Pricing via sqft_lawn bracket, basic column.',
  },
];

exports.up = async function (knex) {
  for (const v of VARIANTS) {
    const exists = await knex('services').where('service_key', v.service_key).first();
    if (exists) continue;

    await knex('services').insert({
      service_key: v.service_key,
      name: `Lawn Care Program — ${v.short_suffix}`,
      short_name: 'Lawn Care',
      description: 'Recurring lawn care program including fertilization, pre/post-emergent weed control, and insect prevention. Customized to turf type (St. Augustine, Bahia, Zoysia, Bermuda, Centipede) and lot size.',
      internal_notes: v.internal_notes,
      category: 'lawn_care',
      billing_type: 'recurring',
      frequency: v.frequency,
      visits_per_year: v.visits_per_year,
      is_waveguard: true,
      default_duration_minutes: 45,
      min_duration_minutes: 25,
      max_duration_minutes: 75,
      scheduling_buffer_minutes: 0,
      requires_follow_up: false,
      pricing_type: 'variable',
      base_price: v.base_price,
      price_range_min: 30.00,
      price_range_max: 250.00,
      pricing_model_key: 'sqft_lawn',
      is_taxable: true,
      tax_service_key: 'lawn_care',
      requires_license: true,
      license_category: 'L&O',
      min_tech_skill_level: 1,
      default_products: JSON.stringify(['0-0-7 Granular', 'Celsius WG', 'Dismiss', 'Bifen XTS']),
      customer_visible: true,
      booking_enabled: true,
      icon: '🌱',
      color: '#10b981',
      sort_order: v.sort_order,
      is_active: true,
      is_archived: false,
    });
  }
};

exports.down = async function (knex) {
  await knex('services')
    .whereIn('service_key', VARIANTS.map((v) => v.service_key))
    .del();
};
