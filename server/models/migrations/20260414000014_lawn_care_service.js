/**
 * Add Lawn Care recurring service to the service library.
 * Full-program entry: fertilization, weed control, insect prevention — bimonthly.
 */
exports.up = async function (knex) {
  const exists = await knex('services').where('service_key', 'lawn_care_recurring').first();
  if (exists) return;

  await knex('services').insert({
    service_key: 'lawn_care_recurring',
    name: 'Lawn Care Program',
    short_name: 'Lawn Care',
    description: 'Complete recurring lawn care program including fertilization, pre/post-emergent weed control, and insect prevention. Customized to turf type (St. Augustine, Bahia, Zoysia, Bermuda, Centipede) and lot size.',
    internal_notes: 'Pricing by sqft bracket per grass track. 6-8 rounds/yr depending on grass type. See pricing engine tracks A-D.',
    category: 'lawn_care',
    billing_type: 'recurring',
    frequency: 'bimonthly',
    visits_per_year: 6,
    is_waveguard: true,
    default_duration_minutes: 45,
    min_duration_minutes: 25,
    max_duration_minutes: 75,
    scheduling_buffer_minutes: 0,
    requires_follow_up: false,
    pricing_type: 'variable',
    base_price: 46.00,
    price_range_min: 36.00,
    price_range_max: 120.00,
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
    sort_order: 9,
    is_active: true,
    is_archived: false,
  });
};

exports.down = async function (knex) {
  await knex('services').where('service_key', 'lawn_care_recurring').del();
};
