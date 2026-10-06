/**
 * Vehicle German roach services (owner ruling 2026-10-06).
 *
 * A caller with German roaches in a car (first case: a 2024 Jeep Grand
 * Cherokee, 10-06) had no catalog row, so the call agent matched the home
 * roach package and the office had no price to book. Owner price:
 *
 *   vehicle_german_roach  $199 fixed, one-time, TWO visits (treatment + an
 *                         included follow-up 14 days later). booking_enabled
 *                         is FALSE: only the call-recording pipeline loads it,
 *                         and only with GATE_CALL_VEHICLE_ROACH_BOOKING on
 *                         (loadBookableCallServices includeVehicleRoach), so
 *                         the voice agent and SMS drafter never offer it. Joins the
 *                         two-treatment package set in code
 *                         (typed-followup-obligation / package-followup-booking)
 *                         so the follow-up is bounded to ONE included visit.
 *   vehicle_roach_addon   $99 fixed, one-time: the car added to a home
 *                         German roach job. Office use only (not bookable by
 *                         the call agent, not on the public quote form).
 *
 * Both are excluded from percentage discounts, like every other roach row
 * (20260520000004). The vehicle job gets the same typed cockroach report form
 * as cockroach_control, with the 14-day ALERT follow-up policy.
 *
 * Inserts never overwrite: a row an admin already created under the same key
 * is left as it is. down() removes only rows this migration inserted and only
 * when no visit, estimate line or invoice line references them; a referenced
 * row is deactivated instead and stays recorded in the state row as
 * `retained`, so a later up() reactivates it (with its original flags) rather
 * than leaving the key dead behind the "row already exists" skip.
 */

const SERVICES = [
  {
    service_key: 'vehicle_german_roach',
    name: 'Vehicle German Roach Treatment (2 Visits)',
    short_name: 'Vehicle Roach',
    description: 'German cockroach treatment for a car, truck or van: gel bait, IGR and a non-repellent treatment of the interior, plus an included follow-up visit 14 days later to break the breeding cycle.',
    category: 'pest_control',
    billing_type: 'one_time',
    visits_per_year: 2,
    default_duration_minutes: 60,
    min_duration_minutes: 45,
    max_duration_minutes: 90,
    pricing_type: 'fixed',
    base_price: 199.0,
    price_range_min: null,
    price_range_max: null,
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    requires_follow_up: true,
    follow_up_interval_days: 14,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪳',
    color: '#0ea5e9',
    sort_order: 14,
    default_products: JSON.stringify(['Advion Gel', 'Gentrol IGR']),
    internal_notes: 'Owner price 2026-10-06: $199 covers both visits. Read the product label before treating a vehicle interior. Ask where the car is parked; the source is often the home or workplace.',
  },
  {
    service_key: 'vehicle_roach_addon',
    name: 'Vehicle Roach Add-On',
    short_name: 'Vehicle Add-On',
    description: 'Treat the customer\'s car as part of a home German roach treatment.',
    category: 'pest_control',
    billing_type: 'one_time',
    visits_per_year: null,
    default_duration_minutes: 30,
    min_duration_minutes: 20,
    max_duration_minutes: 45,
    pricing_type: 'fixed',
    base_price: 99.0,
    price_range_min: null,
    price_range_max: null,
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    requires_follow_up: false,
    follow_up_interval_days: null,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪳',
    color: '#0ea5e9',
    sort_order: 15,
    default_products: JSON.stringify(['Advion Gel', 'Gentrol IGR']),
    internal_notes: 'Owner price 2026-10-06: $99 when the car is treated with a home German roach job.',
  },
];

const KEYS = SERVICES.map((s) => s.service_key);
const STATE_KEY = 'migration_20261007000200_vehicle_german_roach_state';

async function columnsOf(knex, table) {
  return Object.keys(await knex(table).columnInfo());
}

function pick(row, columns) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => columns.includes(k)));
}

async function readState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first('value');
  if (!row) return null;
  try { return typeof row.value === 'string' ? JSON.parse(row.value) : (row.value || null); } catch (_e) { return null; }
}

async function writeState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first('key');
  if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value, updated_at: knex.fn.now() });
  else await knex('system_settings').insert({ key: STATE_KEY, value, category: 'migrations', description: 'Rows owned by migration 20261007000200 (vehicle German roach services)' });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const serviceColumns = await columnsOf(knex, 'services');
  const prior = await readState(knex);
  const retained = new Map((Array.isArray(prior?.retained) ? prior.retained : []).map((r) => [r.key, r]));
  const inserted = [];
  for (const service of SERVICES) {
    const existing = await knex('services').where({ service_key: service.service_key }).first('id');
    const owned = existing && retained.get(service.service_key);
    if (owned && owned.id === existing.id) {
      // A row this migration inserted, kept by an earlier down() because a
      // visit referenced it: restore the flags down() turned off.
      await knex('services').where({ id: existing.id }).update(pick({
        is_active: service.is_active,
        booking_enabled: service.booking_enabled,
      }, serviceColumns));
      inserted.push({ key: service.service_key, id: existing.id });
      continue;
    }
    if (existing) {
      console.warn(`[vehicle-roach] ${service.service_key}: row already exists — left as it is`);
      continue;
    }
    const [row] = await knex('services').insert(pick(service, serviceColumns)).returning('id');
    inserted.push({ key: service.service_key, id: row?.id || row });
  }

  if (await knex.schema.hasTable('service_discount_rules')) {
    await knex('service_discount_rules')
      .insert(KEYS.map((key) => ({
        service_key: key,
        tier_qualifier: false,
        max_discount_pct: null,
        flat_credit: null,
        flat_credit_min_tier: null,
        exclude_from_pct_discount: true,
        notes: 'Vehicle roach work is a flat owner price, excluded from percentage discounts like every roach row.',
        updated_at: knex.fn.now(),
      })))
      .onConflict('service_key')
      .ignore();
  }

  let profileInserted = false;
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const existingProfile = await knex('service_completion_profiles').where({ service_key: 'vehicle_german_roach' }).first('service_key');
    if (!existingProfile) {
      const profileColumns = await columnsOf(knex, 'service_completion_profiles');
      await knex('service_completion_profiles').insert(pick({
        service_key: 'vehicle_german_roach',
        service_name_snapshot: SERVICES[0].name,
        category: 'pest_control',
        billing_type: 'one_time',
        completion_mode: 'service_report',
        project_type: 'cockroach',
        delivery_mode: 'auto_send',
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'alert',
        default_followup_days: 14,
        active: true,
        notes: '[vehicle_roach_migration=inserted]',
      }, profileColumns));
      profileInserted = true;
    }
  }

  await writeState(knex, { inserted, profileInserted: profileInserted || prior?.profileInserted === true });
};

async function isReferenced(knex, serviceId) {
  const checks = [
    ['scheduled_services', 'service_id'],
    ['estimate_line_items', 'service_id'],
    ['invoice_line_items', 'service_id'],
  ];
  for (const [table, column] of checks) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) continue;
    if (await knex(table).where(column, serviceId).first(column)) return true;
  }
  return false;
}

exports.down = async function down(knex) {
  const state = await readState(knex);
  if (!state) return;
  const inserted = Array.isArray(state.inserted) ? state.inserted : [];
  const retained = [];

  for (const { key, id } of inserted) {
    if (!id) continue;
    if (await isReferenced(knex, id)) {
      await knex('services').where({ id }).update({ is_active: false, booking_enabled: false });
      retained.push({ key, id });
      console.warn(`[vehicle-roach] ${key}: referenced — deactivated, not deleted`);
      continue;
    }
    await knex('services').where({ id }).del();
    if (await knex.schema.hasTable('service_discount_rules')) {
      await knex('service_discount_rules').where({ service_key: key }).del();
    }
    if (key === 'vehicle_german_roach' && state.profileInserted && await knex.schema.hasTable('service_completion_profiles')) {
      await knex('service_completion_profiles')
        .where({ service_key: key, notes: '[vehicle_roach_migration=inserted]' })
        .del();
    }
  }
  if (retained.length) {
    // The profile and discount rule of a retained row stay with it.
    await writeState(knex, { inserted: [], retained, profileInserted: state.profileInserted === true });
  } else {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
