/**
 * Vehicle German roach services in the catalog (owner ruling 2026-10-06, split
 * 2026-10-08: catalog rows and office handling only; the call agent does not
 * book them).
 *
 * A caller with German roaches in a car (first case: a 2024 Jeep Grand
 * Cherokee, 10-06) had no catalog row, so the office had no price to book.
 * Owner price:
 *
 *   vehicle_german_roach  $199 fixed, one-time, TWO visits (treatment + an
 *                         included follow-up 14 days later). Joins the
 *                         two-treatment package set in code
 *                         (typed-followup-obligation / package-followup-booking)
 *                         so the follow-up is bounded to ONE included visit.
 *   vehicle_roach_addon   $99 fixed, one-time: the car added to a home
 *                         German roach job. Office use only.
 *
 * Both rows ship booking_enabled=false and customer_visible=false. The only
 * loader the call, voice and SMS pipelines share (call-booking-catalog.js
 * loadBookableCallServices) reads is_active + booking_enabled=true, so none of
 * them can load either row; staff book them in Admin Schedule. customer_visible
 * is false because the anonymous public MCP catalog (routes/public-mcp.js
 * listServices/getService), the sales-support lookup (estimate-ai-context.js)
 * and the social campaign context list every active customer_visible row and
 * never read booking_enabled, so a visible office-only row would be advertised
 * there. The one cost is the plain-language summary line on the customer
 * tracking page (tracking.js / track-public.js), which hides itself for a
 * customer_visible=false service; invoice lines, visit names and the portal
 * never read the flag.
 *
 * Both are excluded from percentage discounts. The rule rows below feed the
 * pricing admin and discount-engine.js; Admin Schedule and its client picker do
 * not read them: they use WAVEGUARD.excludedFromPercentDiscount in
 * pricing-engine/constants.js, where both keys are listed (codex #6162 r1 P1).
 *
 * The vehicle job gets the same typed cockroach report form as
 * cockroach_control, with the 14-day ALERT follow-up policy. The add-on is a
 * billing rider (completion-lane-registry.js BILLING_RIDER_KEYS): its profile is
 * internal_only with delivery disabled, so it never runs a report of its own.
 * The car job declares the household German roach products (Alpine WSG, Advion
 * Gel, Gentrol IGR; owner 2026-10-08) and uses the same protocol, form and report.
 *
 * Inserts never overwrite price or any other field: a row an admin already
 * created under the same key keeps its content. Only its two safety flags are
 * reconciled (customer_visible and booking_enabled forced to false, so a stale
 * visible row cannot reach the anonymous catalog); the prior values go in the
 * state row and down() restores them. The state row also records each service
 * row this migration inserted.
 *
 * down() deactivates; it never deletes. It sets is_active=false and
 * booking_enabled=false on each service row this migration inserted and records
 * it in the state row as `retained`; it restores the two safety flags on
 * pre-existing rows it reconciled; it touches nothing else. Discount rules,
 * completion profiles and every other field of every row stay as they are, so an
 * admin's edits made after deployment (price, name, notes) survive a rollback and
 * no visit, add-on, package link, invoice line or lead can lose its row. A later
 * up() reactivates a retained row (is_active and booking_enabled back to the
 * values above) rather than leaving the key dead behind the "row already exists"
 * skip.
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

// Completion lane (completion-lane-registry.js): the car job is a typed
// cockroach report; the $99 add-on is a billing rider (invoice line, no report
// of its own), so it takes the enforced rider posture: internal_only, no
// pointer, delivery disabled.
const PROFILES = {
  vehicle_german_roach: {
    completion_mode: 'service_report',
    project_type: 'cockroach',
    delivery_mode: 'auto_send',
    portal_visibility: 'customer_portal',
    portal_attach_policy: 'active_portal_customer',
    followup_policy: 'alert',
    default_followup_days: 14,
  },
  vehicle_roach_addon: {
    completion_mode: 'internal_only',
    project_type: null,
    delivery_mode: 'disabled',
    portal_visibility: 'token_only',
    portal_attach_policy: 'recurring_customer',
    followup_policy: 'none',
    default_followup_days: null,
  },
};
const RULE_NOTES = 'Vehicle roach work is a flat owner price, excluded from percentage discounts like every roach row.';
// The two flags that decide whether a row can be offered anywhere.
const SAFETY_FLAGS = ['customer_visible', 'booking_enabled'];

const STATE_KEY = 'migration_20261008170000_vehicle_roach_catalog_state';

const list = (value) => (Array.isArray(value) ? value : []);

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
  try { return typeof row.value === 'string' ? JSON.parse(row.value) : (row.value || null); } catch { return null; }
}

async function writeState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first('key');
  if (existing) await knex('system_settings').where({ key: STATE_KEY }).update({ value, updated_at: knex.fn.now() });
  else await knex('system_settings').insert({ key: STATE_KEY, value, category: 'migrations', description: 'Rows owned by migration 20261008170000 (vehicle German roach catalog rows)' });
}

// Only service rows this migration inserted are tracked: down() deactivates
// them. A re-run keeps what an earlier run recorded.
function startState(prior) {
  return {
    inserted: list(prior?.inserted).filter((r) => r && r.key && r.id),
    reconciled: list(prior?.reconciled),
  };
}

const markInserted = (state, key, id) => {
  if (!state.inserted.some((r) => r.key === key)) state.inserted.push({ key, id });
};

// A row already under the key: change nothing but the two safety flags.
async function reconcileExisting(ctx, key, existing) {
  const { knex, state } = ctx;
  const ours = state.inserted.some((r) => r.key === key && r.id === existing.id);
  const unsafe = SAFETY_FLAGS.filter((flag) => ctx.serviceColumns.includes(flag) && existing[flag]);
  if (ours || !unsafe.length || state.reconciled.some((r) => r.key === key)) return;
  await knex('services').where({ id: existing.id }).update(Object.fromEntries(unsafe.map((flag) => [flag, false])));
  state.reconciled.push({ key, id: existing.id, ...Object.fromEntries(unsafe.map((flag) => [flag, true])) });
  console.warn(`[vehicle-roach] ${key}: row already exists — kept, but ${unsafe.join(' and ')} set to false`);
}

async function ensureService(ctx, service) {
  const { knex, state, serviceColumns } = ctx;
  const key = service.service_key;
  const existing = await knex('services').where({ service_key: key }).first();
  if (!existing) {
    const [row] = await knex('services').insert(pick(service, serviceColumns)).returning('id');
    markInserted(state, key, row?.id || row);
    return;
  }
  const owned = ctx.retained.get(key);
  if (owned && owned.id === existing.id) {
    // A row this migration inserted, kept by an earlier down() because a visit
    // referenced it: restore the flags down() turned off.
    await knex('services').where({ id: existing.id }).update(pick({
      is_active: service.is_active,
      booking_enabled: service.booking_enabled,
    }, serviceColumns));
    markInserted(state, key, existing.id);
    return;
  }
  await reconcileExisting(ctx, key, existing);
}

async function ensureRule(ctx, key) {
  const { knex } = ctx;
  if (await knex('service_discount_rules').where({ service_key: key }).first('service_key')) return;
  await knex('service_discount_rules')
    .insert({
      service_key: key,
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: RULE_NOTES,
      updated_at: knex.fn.now(),
    })
    .onConflict('service_key')
    .ignore();
}

async function ensureProfile(ctx, service) {
  const { knex } = ctx;
  const key = service.service_key;
  if (await knex('service_completion_profiles').where({ service_key: key }).first('service_key')) return;
  await knex('service_completion_profiles').insert(pick({
    service_key: key,
    service_name_snapshot: service.name,
    category: 'pest_control',
    billing_type: 'one_time',
    creates_service_record: true,
    active: true,
    ...PROFILES[key],
  }, ctx.profileColumns));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const prior = await readState(knex);
  const ctx = {
    knex,
    serviceColumns: await columnsOf(knex, 'services'),
    state: startState(prior),
    retained: new Map(list(prior?.retained).map((r) => [r.key, r])),
    hasRules: await knex.schema.hasTable('service_discount_rules'),
    profileColumns: (await knex.schema.hasTable('service_completion_profiles')) ? await columnsOf(knex, 'service_completion_profiles') : null,
  };
  for (const service of SERVICES) {
    await ensureService(ctx, service);
    if (ctx.hasRules) await ensureRule(ctx, service.service_key);
    if (ctx.profileColumns) await ensureProfile(ctx, service);
  }
  await writeState(knex, ctx.state);
};

// Put a pre-existing row's safety flags back, unless someone changed them since.
async function restoreFlags(knex, { id, customer_visible: visible, booking_enabled: bookable }) {
  const patch = pick({ customer_visible: !!visible, booking_enabled: !!bookable }, SAFETY_FLAGS);
  await knex('services').where({ id, customer_visible: false, booking_enabled: false }).update(patch);
}

// Deactivate, never delete: nothing is removed, so nothing an admin or a visit
// attached to the row afterwards can be lost.
exports.down = async function down(knex) {
  const state = await readState(knex);
  if (!state) return;
  for (const entry of list(state.reconciled)) await restoreFlags(knex, entry);

  const inserted = list(state.inserted).filter((r) => r && r.key && r.id);
  for (const { id } of inserted) await knex('services').where({ id }).update({ is_active: false, booking_enabled: false });
  const retained = (inserted.length ? inserted : list(state.retained)).map(({ key, id }) => ({ key, id }));

  if (!retained.length) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    return;
  }
  await writeState(knex, { inserted: [], reconciled: [], retained });
};

exports._test = { SERVICES };
