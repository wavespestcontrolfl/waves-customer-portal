/**
 * Service-library cleanup — consolidates lawn / mosquito / tree-shrub / palm
 * catalog entries to match the new Bi-Monthly / Every-6-Weeks / One-Time
 * naming pattern and removes legacy / unused service rows.
 *
 *  1. Adds `lawn_care_one_time` and `mosquito_one_time` catalog entries.
 *  2. Renames `tree_shrub_program` → "Bi-Monthly Tree & Shrub Care Service"
 *     and `tree_shrub_6week` → "Every 6 Weeks Tree & Shrub Care Service".
 *  3. Repoints WaveGuard Silver/Gold/Platinum package_items from
 *     `lawn_fertilization` to `lawn_care_recurring` (same cadence, same
 *     program, consolidated name).
 *  4. Removes `palm_treatment` from WaveGuard Platinum package_items.
 *  5. Archives the legacy/retired services (catalog-hidden, history preserved):
 *       lawn_fertilization, lawn_fungicide, lawn_insect_control, lawn_aeration,
 *       mosquito_event, palm_treatment, palm_injection.
 *
 * Hard-delete is intentionally avoided — `service_records`,
 * `scheduled_services`, and `service_package_items` FK to `services.id`, so
 * archiving keeps historical references valid while hiding the rows from the
 * admin catalog and customer-facing booking surfaces.
 *
 * NOTE: `palm_injection` still has ~33 code references across the pricing
 * engine (per-palm pricing, Gold+ flat credit, discount engine, AI matching).
 * This migration only catalog-archives the row; full code removal lands in
 * a follow-up PR.
 */

const NEW_SERVICES = [
  {
    service_key: 'lawn_care_one_time',
    name: 'One-Time Lawn Care Service',
    short_name: 'Lawn Care',
    description:
      'Single-visit lawn treatment — fertilization, weed control, or insect/disease application as scoped at quote. Use for spot treatments, callbacks, or out-of-program visits.',
    internal_notes:
      'One-time lawn visit. Pricing scoped manually per quote; no recurring billing.',
    category: 'lawn_care',
    billing_type: 'one_time',
    frequency: null,
    visits_per_year: null,
    is_waveguard: false,
    default_duration_minutes: 60,
    min_duration_minutes: 30,
    max_duration_minutes: 90,
    scheduling_buffer_minutes: 0,
    requires_follow_up: false,
    pricing_type: 'variable',
    base_price: null,
    price_range_min: null,
    price_range_max: null,
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
    sort_order: 14,
    is_active: true,
    is_archived: false,
  },
  {
    service_key: 'mosquito_one_time',
    name: 'One-Time Mosquito Control Service',
    short_name: 'Mosquito',
    description:
      'Single-visit mosquito treatment — barrier mist of foliage, eaves, and breeding sites. Use for event prep, callbacks, or out-of-program visits.',
    internal_notes:
      'One-time mosquito visit. Replaces the retired mosquito_event row. Pricing scoped manually per quote.',
    category: 'mosquito',
    billing_type: 'one_time',
    frequency: null,
    visits_per_year: null,
    is_waveguard: false,
    default_duration_minutes: 60,
    min_duration_minutes: 30,
    max_duration_minutes: 90,
    scheduling_buffer_minutes: 0,
    requires_follow_up: false,
    pricing_type: 'variable',
    base_price: null,
    price_range_min: null,
    price_range_max: null,
    pricing_model_key: null,
    is_taxable: true,
    tax_service_key: 'mosquito',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 1,
    default_products: JSON.stringify(['Talstar', 'Onslaught FastCap']),
    customer_visible: true,
    booking_enabled: true,
    icon: '🦟',
    color: '#0ea5e9',
    sort_order: 23,
    is_active: true,
    is_archived: false,
  },
];

const TREE_SHRUB_RENAMES = [
  { service_key: 'tree_shrub_program', name: 'Bi-Monthly Tree & Shrub Care Service' },
  { service_key: 'tree_shrub_6week', name: 'Every 6 Weeks Tree & Shrub Care Service' },
];

const SERVICES_TO_ARCHIVE = [
  'lawn_fertilization',
  'lawn_fungicide',
  'lawn_insect_control',
  'lawn_aeration',
  'mosquito_event',
  'palm_treatment',
  'palm_injection',
];

exports.up = async function up(knex) {
  // 1. Insert new one-time services (idempotent).
  for (const svc of NEW_SERVICES) {
    const exists = await knex('services').where('service_key', svc.service_key).first();
    if (!exists) {
      await knex('services').insert(svc);
    }
  }

  // 2. Rename Tree & Shrub variants to match the lawn naming pattern.
  for (const row of TREE_SHRUB_RENAMES) {
    await knex('services')
      .where('service_key', row.service_key)
      .update({ name: row.name, updated_at: knex.fn.now() });
  }

  // 3. Repoint WaveGuard package_items from lawn_fertilization → lawn_care_recurring.
  const lawnFert = await knex('services').where('service_key', 'lawn_fertilization').first('id');
  const lawnRecurring = await knex('services')
    .where('service_key', 'lawn_care_recurring')
    .first('id');

  if (lawnFert && lawnRecurring) {
    // If a package already has a row for lawn_care_recurring (e.g. partial run),
    // drop the duplicate lawn_fertilization row instead of triggering the unique
    // constraint on (package_id, service_id).
    const recurringRows = await knex('service_package_items')
      .where('service_id', lawnRecurring.id)
      .select('package_id');
    const recurringPkgIds = new Set(recurringRows.map((r) => r.package_id));

    const fertRows = await knex('service_package_items')
      .where('service_id', lawnFert.id)
      .select('id', 'package_id');

    for (const r of fertRows) {
      if (recurringPkgIds.has(r.package_id)) {
        await knex('service_package_items').where('id', r.id).del();
      } else {
        await knex('service_package_items')
          .where('id', r.id)
          .update({ service_id: lawnRecurring.id });
      }
    }
  }

  // 4. Remove palm_treatment from WaveGuard Platinum (its only package).
  const palmTreatment = await knex('services').where('service_key', 'palm_treatment').first('id');
  if (palmTreatment) {
    await knex('service_package_items').where('service_id', palmTreatment.id).del();
  }

  // 5. Archive retired services. is_active=false hides from active picklists;
  //    is_archived=true is the canonical archived flag; customer_visible/
  //    booking_enabled=false hide from customer-facing surfaces. Historical
  //    service_records / scheduled_services rows keep their FK intact.
  await knex('services')
    .whereIn('service_key', SERVICES_TO_ARCHIVE)
    .update({
      is_active: false,
      is_archived: true,
      customer_visible: false,
      booking_enabled: false,
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down(knex) {
  // 5. Un-archive.
  await knex('services')
    .whereIn('service_key', SERVICES_TO_ARCHIVE)
    .update({
      is_active: true,
      is_archived: false,
      customer_visible: true,
      booking_enabled: true,
      updated_at: knex.fn.now(),
    });

  // 4. Restore palm_treatment to WaveGuard Platinum.
  const palmTreatment = await knex('services').where('service_key', 'palm_treatment').first('id');
  const platinum = await knex('service_packages')
    .where('package_key', 'waveguard_platinum')
    .first('id');
  if (palmTreatment && platinum) {
    const existing = await knex('service_package_items')
      .where({ package_id: platinum.id, service_id: palmTreatment.id })
      .first();
    if (!existing) {
      await knex('service_package_items').insert({
        package_id: platinum.id,
        service_id: palmTreatment.id,
        is_included: true,
        included_visits: 4,
        sort_order: 5,
      });
    }
  }

  // 3. Repoint package_items back to lawn_fertilization.
  const lawnFert = await knex('services').where('service_key', 'lawn_fertilization').first('id');
  const lawnRecurring = await knex('services')
    .where('service_key', 'lawn_care_recurring')
    .first('id');
  if (lawnFert && lawnRecurring) {
    // Only repoint rows that originally belonged to lawn_fertilization;
    // we can't perfectly distinguish, so repoint only those whose package
    // had no prior lawn_fertilization row before this migration ran. In
    // practice all three (Silver/Gold/Platinum) qualify.
    const targetPackages = ['waveguard_silver', 'waveguard_gold', 'waveguard_platinum'];
    const pkgRows = await knex('service_packages').whereIn('package_key', targetPackages).select('id');
    const pkgIds = pkgRows.map((r) => r.id);
    await knex('service_package_items')
      .whereIn('package_id', pkgIds)
      .andWhere('service_id', lawnRecurring.id)
      .update({ service_id: lawnFert.id });
  }

  // 2. Revert Tree & Shrub names.
  await knex('services')
    .where('service_key', 'tree_shrub_program')
    .update({ name: 'Tree & Shrub Care Program Service', updated_at: knex.fn.now() });
  await knex('services')
    .where('service_key', 'tree_shrub_6week')
    .update({ name: 'Tree & Shrub Care Service', updated_at: knex.fn.now() });

  // 1. Remove inserted one-time services.
  await knex('services')
    .whereIn('service_key', NEW_SERVICES.map((s) => s.service_key))
    .del();
};
