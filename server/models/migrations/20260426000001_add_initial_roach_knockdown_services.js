/**
 * Add Initial Roach Knockdown services to the service library
 *
 * Pairs with the new auto-fired one-time line item from the pest pricing
 * engine (server/services/pricing-engine/service-pricing.js
 * → pricePestInitialRoach). When a recurring pest customer flags a roach
 * issue, the engine emits a `pest_initial_roach` line item on visit 1 to
 * recover the heavier-knockdown product + labor cost regardless of churn.
 * These catalog rows make those services visible in the Service Library
 * tab so they can be invoiced / scheduled / reported on as first-class
 * services rather than ad-hoc line items.
 *
 * Pricing in this catalog reflects the midpoint of the engine's per-species
 * sliding scale by footprint (palmetto $119/$139/$169, german $169/$199/$249).
 *
 * New services added:
 *   PEST CONTROL
 *     - pest_initial_palmetto_knockdown   (one-time, native SWFL species:
 *                                          American / palmetto, smoky brown,
 *                                          Australian, Florida woods)
 *     - pest_initial_german_knockdown     (one-time, german)
 */
exports.up = async function (knex) {
  const services = [
    {
      service_key: 'pest_initial_palmetto_knockdown',
      name: 'Initial Native Roach Knockdown',
      short_name: 'Native Roach Initial',
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting any of the native SWFL cockroaches (American / palmetto, smoky brown, Australian, Florida woods). Includes interior spray, crack-and-crevice in kitchen / bath / utility, perimeter granular, and bait gel placement at hot spots. Auto-added by the pest engine when recurring pest is booked with roachType=regular; pricing slides by footprint ($119 under 1,500 sf, $139 mid, $169 over 2,500 sf).',
      category: 'pest_control',
      billing_type: 'one_time',
      default_duration_minutes: 35,
      min_duration_minutes: 25,
      max_duration_minutes: 45,
      pricing_type: 'variable',
      base_price: 139.00,
      price_range_min: 119.00,
      price_range_max: 169.00,
      is_waveguard: false,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🪳',
      color: '#0ea5e9',
      sort_order: 6,
      default_products: JSON.stringify(['Tekko Pro IGR', 'Demand CS', 'Maxforce Bait Gel']),
    },
    {
      service_key: 'pest_initial_german_knockdown',
      name: 'Initial German Roach Knockdown',
      short_name: 'German Initial',
      description: 'Heavier visit-1 treatment for new recurring pest customers reporting German cockroaches (small indoor / kitchen species). Includes interior spray, gel bait placement at hot spots, and an insect growth regulator to break the breeding cycle. Indoor breeding biology requires longer visit, heavier product rotation, and IGR-driven follow-up. NOT a substitute for the dedicated 3-visit German Roach Cleanout program for severe infestations — this is the auto-add for the everyday "I saw one or two" case. Auto-added by the pest engine when recurring pest is booked with roachType=german; pricing slides by footprint ($169 under 1,500 sf, $199 mid, $249 over 2,500 sf).',
      category: 'pest_control',
      billing_type: 'one_time',
      default_duration_minutes: 50,
      min_duration_minutes: 40,
      max_duration_minutes: 75,
      pricing_type: 'variable',
      base_price: 199.00,
      price_range_min: 169.00,
      price_range_max: 249.00,
      is_waveguard: false,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🪳',
      color: '#0ea5e9',
      sort_order: 7,
      default_products: JSON.stringify(['Tekko Pro IGR', 'Demand CS', 'Maxforce Bait Gel', 'Alpine WSG']),
    },
  ];

  // Only insert services that don't already exist (safe for re-runs).
  for (const svc of services) {
    const exists = await knex('services').where('service_key', svc.service_key).first();
    if (!exists) {
      await knex('services').insert(svc);
    }
  }
};

exports.down = async function (knex) {
  const keysToRemove = [
    'pest_initial_palmetto_knockdown',
    'pest_initial_german_knockdown',
  ];

  // Null out FKs pointing to these services before deleting (matches the
  // pattern in 20260408000001 — keeps service_records / scheduled_services
  // intact so audit history isn't lost on a rollback).
  const ids = await knex('services').whereIn('service_key', keysToRemove).pluck('id');

  if (ids.length > 0) {
    const srHas = await knex.schema.hasColumn('service_records', 'service_id');
    if (srHas) {
      await knex('service_records').whereIn('service_id', ids).update({ service_id: null });
    }
    const ssHas = await knex.schema.hasColumn('scheduled_services', 'service_id');
    if (ssHas) {
      await knex('scheduled_services').whereIn('service_id', ids).update({ service_id: null });
    }
  }

  await knex('services').whereIn('service_key', keysToRemove).del();
};
