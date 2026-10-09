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
 * Both ship customer_visible=false, the way the other staff-only, non-bookable
 * rows do (bed bug 20260611000006, rodent trap check 20260927000001). The
 * anonymous public MCP catalog (routes/public-mcp.js listServices/getService),
 * the sales-support lookup (estimate-ai-context.js) and the social campaign
 * context list every active customer_visible row and never read booking_enabled,
 * so a visible office-only row would be advertised there. The one cost is the
 * plain-language summary line on the customer tracking page
 * (tracking.js / track-public.js), which hides itself for a customer_visible=false
 * service; invoice lines, visit names and the portal never read the flag.
 *
 * Both are excluded from percentage discounts. The rule rows below feed the
 * pricing admin and discount-engine.js; Admin Schedule and its client picker do
 * not read them: they use WAVEGUARD.excludedFromPercentDiscount in
 * pricing-engine/constants.js, where both keys are listed (codex #6162 r1 P1).
 *
 * The vehicle job gets the same typed cockroach report form
 * as cockroach_control, with the 14-day ALERT follow-up policy. The add-on is a
 * billing rider (completion-lane-registry.js BILLING_RIDER_KEYS): its profile is
 * internal_only with delivery disabled, so it never runs a report of its own.
 *
 * The car job declares the household German roach products (Alpine WSG, Advion
 * Gel, Gentrol IGR; owner 2026-10-08) and uses the same protocol, form and report.
 *
 * Inserts never overwrite: a row an admin already created under the same key
 * is left as it is. The state row records each service row, discount rule and
 * completion profile this migration inserted on its own, so down() removes the
 * rules and profiles it inserted even next to a service row it left alone.
 * down() removes only rows this migration inserted and only
 * when nothing references them (visits, visit add-ons, service records,
 * service_addons / package links, estimate and invoice lines, discounts,
 * leads); a referenced row is deactivated instead and stays recorded in the state row as
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
    customer_visible: false,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪳',
    color: '#0ea5e9',
    sort_order: 14,
    // Same protocol as the home German roach job (cockroach_control, migration
    // 20260602000002; owner 2026-10-08: "Alpine and Gentrol with bait").
    default_products: JSON.stringify(['Alpine WSG', 'Advion Gel', 'Gentrol IGR']),
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
    customer_visible: false,
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
const PROFILE_MARKER = '[vehicle_roach_migration=inserted]';
const PROFILES = [
  {
    service_key: 'vehicle_german_roach',
    profile: {
      completion_mode: 'service_report',
      project_type: 'cockroach',
      delivery_mode: 'auto_send',
      portal_visibility: 'customer_portal',
      portal_attach_policy: 'active_portal_customer',
      followup_policy: 'alert',
      default_followup_days: 14,
    },
  },
  {
    service_key: 'vehicle_roach_addon',
    profile: {
      completion_mode: 'internal_only',
      project_type: null,
      delivery_mode: 'disabled',
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: 'none',
      default_followup_days: null,
    },
  },
];

const STATE_KEY = 'migration_20261008150000_vehicle_german_roach_state';

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
  else await knex('system_settings').insert({ key: STATE_KEY, value, category: 'migrations', description: 'Rows owned by migration 20261008150000 (vehicle German roach services)' });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const serviceColumns = await columnsOf(knex, 'services');
  const prior = await readState(knex);
  const retained = new Map((Array.isArray(prior?.retained) ? prior.retained : []).map((r) => [r.key, r]));
  // Ownership is tracked per record (service row, discount rule, completion
  // profile), because a service key an admin created first leaves the service
  // row alone while up() still inserts the missing rule or profile. A re-run
  // keeps what an earlier run recorded.
  const inserted = (Array.isArray(prior?.inserted) ? prior.inserted : []).filter((r) => r && r.key && r.id);
  const addInserted = (key, id) => {
    if (!inserted.some((r) => r.key === key)) inserted.push({ key, id });
  };
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
      addInserted(service.service_key, existing.id);
      continue;
    }
    if (existing) {
      console.warn(`[vehicle-roach] ${service.service_key}: row already exists — left as it is`);
      continue;
    }
    const [row] = await knex('services').insert(pick(service, serviceColumns)).returning('id');
    addInserted(service.service_key, row?.id || row);
  }

  const rulesInserted = [...(Array.isArray(prior?.rules) ? prior.rules : [])];
  if (await knex.schema.hasTable('service_discount_rules')) {
    for (const key of KEYS) {
      if (await knex('service_discount_rules').where({ service_key: key }).first('service_key')) continue;
      await knex('service_discount_rules')
        .insert({
          service_key: key,
          tier_qualifier: false,
          max_discount_pct: null,
          flat_credit: null,
          flat_credit_min_tier: null,
          exclude_from_pct_discount: true,
          notes: 'Vehicle roach work is a flat owner price, excluded from percentage discounts like every roach row.',
          updated_at: knex.fn.now(),
        })
        .onConflict('service_key')
        .ignore();
      if (!rulesInserted.includes(key)) rulesInserted.push(key);
    }
  }

  // Completion lane (completion-lane-registry.js): the car job is a typed
  // cockroach report; the $99 add-on is a billing rider (invoice line plus a
  // reference in the home visit's report, no report of its own), so it takes
  // the enforced rider posture: internal_only, no pointer, delivery disabled.
  const profilesInserted = [...(Array.isArray(prior?.profiles) ? prior.profiles : [])];
  if (await knex.schema.hasTable('service_completion_profiles')) {
    const profileColumns = await columnsOf(knex, 'service_completion_profiles');
    for (const def of PROFILES) {
      const existingProfile = await knex('service_completion_profiles').where({ service_key: def.service_key }).first('service_key');
      if (existingProfile) continue;
      const service = SERVICES.find((s) => s.service_key === def.service_key);
      await knex('service_completion_profiles').insert(pick({
        service_key: def.service_key,
        service_name_snapshot: service.name,
        category: 'pest_control',
        billing_type: 'one_time',
        creates_service_record: true,
        active: true,
        notes: PROFILE_MARKER,
        ...def.profile,
      }, profileColumns));
      if (!profilesInserted.includes(def.service_key)) profilesInserted.push(def.service_key);
    }
  }

  await writeState(knex, { inserted, rules: rulesInserted, profiles: profilesInserted });
};

// Every place a catalog row can be pointed at. Deleting a services row
// CASCADES through service_addons (both columns) and service_package_items and
// NULLs service_records / scheduled_services / scheduled_service_addons
// .service_id (FKs in 20260401000105 and 20260401000106). The line-item tables
// and leads hold the id or key with no FK. A hit on ANY of them takes the
// deactivate path instead of the delete.
const ID_REFERENCES = [
  ['scheduled_services', 'service_id'],
  ['scheduled_service_addons', 'service_id'],
  ['service_records', 'service_id'],
  ['service_addons', 'parent_service_id'],
  ['service_addons', 'addon_service_id'],
  ['service_package_items', 'service_id'],
  ['estimate_line_items', 'service_id'],
  ['invoice_line_items', 'service_id'],
];
const KEY_REFERENCES = [
  ['discounts', 'service_key_filter'],
  ['leads', 'service_key'],
];

async function isReferenced(knex, serviceId, serviceKey) {
  const checks = [
    ...ID_REFERENCES.map(([table, column]) => [table, column, serviceId]),
    ...KEY_REFERENCES.map(([table, column]) => [table, column, serviceKey]),
  ];
  for (const [table, column, value] of checks) {
    if (!value) continue;
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, column))) continue;
    if (await knex(table).where(column, value).first(column)) return true;
  }
  return false;
}

exports.down = async function down(knex) {
  const state = await readState(knex);
  if (!state) return;
  const inserted = Array.isArray(state.inserted) ? state.inserted : [];
  const ownedRules = Array.isArray(state.rules) ? state.rules : [];
  const ownedProfiles = Array.isArray(state.profiles) ? state.profiles : [];
  const retained = [];

  for (const { key, id } of inserted) {
    if (!id) continue;
    if (await isReferenced(knex, id, key)) {
      await knex('services').where({ id }).update({ is_active: false, booking_enabled: false });
      retained.push({ key, id });
      console.warn(`[vehicle-roach] ${key}: referenced — deactivated, not deleted`);
      continue;
    }
    await knex('services').where({ id }).del();
  }

  // Discount rules and completion profiles are owned one by one, so a record
  // this migration inserted next to a service row it did not insert is removed
  // too. Only a retained service row keeps its rule and profile.
  const retainedKeys = retained.map((r) => r.key);
  const keptRules = ownedRules.filter((key) => retainedKeys.includes(key));
  const keptProfiles = ownedProfiles.filter((key) => retainedKeys.includes(key));
  if (await knex.schema.hasTable('service_discount_rules')) {
    for (const key of ownedRules) {
      if (keptRules.includes(key)) continue;
      await knex('service_discount_rules').where({ service_key: key }).del();
    }
  }
  if (await knex.schema.hasTable('service_completion_profiles')) {
    for (const key of ownedProfiles) {
      if (keptProfiles.includes(key)) continue;
      await knex('service_completion_profiles').where({ service_key: key, notes: PROFILE_MARKER }).del();
    }
  }
  if (retained.length) {
    await writeState(knex, { inserted: [], retained, rules: keptRules, profiles: keptProfiles });
  } else {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports._test = { SERVICES, ID_REFERENCES, KEY_REFERENCES, isReferenced };
