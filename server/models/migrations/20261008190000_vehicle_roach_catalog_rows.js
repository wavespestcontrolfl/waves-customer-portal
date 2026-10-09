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
 * The two keys are new, so no environment should hold them. up() never edits a
 * row it did not create. If a services row with either key exists that this
 * migration does not own (it is not recorded as inserted in the state row), up() THROWS "service_key X already exists and was not created by
 * this migration; resolve by hand" and changes nothing: every existence check
 * runs before the first insert. knex runs a migration inside a transaction, so a
 * throw also rolls back anything already written. Both rows set
 * public_quote_selectable=false explicitly (when the column exists), because
 * /api/public/services/menu selects by that flag alone. The state row records
 * each service row this migration inserted.
 *
 * down() deactivates; it never deletes. For each row this migration owns it sets
 * is_active=false only where is_active is currently true, and writes no other
 * column (not booking_enabled). The state row records which keys down() actually
 * deactivated. A later up() sets is_active=true again only for those keys and
 * touches nothing else. A row an admin already deactivated, or whose booking
 * flag an admin changed, stays exactly as the admin set it through down and up.
 * Discount rules, completion profiles and every other field stay as they are, so
 * admin edits made after deployment survive a rollback and no visit, add-on,
 * package link, invoice line or lead can lose its row.
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
    public_quote_selectable: false,
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
    public_quote_selectable: false,
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
const STATE_KEY = 'migration.20261008190000.state';

const list = (value) => (Array.isArray(value) ? value : []);
const entries = (value) => list(value).filter((r) => r && r.key && r.id).map(({ key, id }) => ({ key, id }));

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
  else await knex('system_settings').insert({ key: STATE_KEY, value, category: 'migrations', description: 'Rows owned by migration 20261008190000 (vehicle German roach catalog rows)' });
}

// Every existence check runs before the first write, so a throw leaves nothing
// half-written. A row under either key that this migration does not own is
// never edited: the migration stops and a person resolves it.
async function planServices(knex, owned) {
  const plan = [];
  for (const service of SERVICES) {
    const key = service.service_key;
    const existing = await knex('services').where({ service_key: key }).first();
    if (existing && owned.get(key) !== existing.id) {
      throw new Error(`service_key ${key} already exists and was not created by this migration; resolve by hand`);
    }
    plan.push({ service, existing });
  }
  return plan;
}

async function ensureRule(knex, key) {
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

async function ensureProfile(knex, profileColumns, service) {
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
  }, profileColumns));
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const prior = await readState(knex);
  const inserted = new Map(entries(prior?.inserted).map((r) => [r.key, r.id]));
  const reactivate = new Set(entries(prior?.deactivated).map((r) => r.key));
  const plan = await planServices(knex, inserted);

  const serviceColumns = await columnsOf(knex, 'services');
  const hasRules = await knex.schema.hasTable('service_discount_rules');
  const profileColumns = (await knex.schema.hasTable('service_completion_profiles')) ? await columnsOf(knex, 'service_completion_profiles') : null;
  for (const { service, existing } of plan) {
    const key = service.service_key;
    if (!existing) {
      const [row] = await knex('services').insert(pick(service, serviceColumns)).returning('id');
      inserted.set(key, row?.id || row);
    } else if (reactivate.has(key)) {
      // Only a key an earlier down() deactivated; nothing else is written.
      await knex('services').where({ id: existing.id, is_active: false }).update({ is_active: true });
    }
    if (hasRules) await ensureRule(knex, key);
    if (profileColumns) await ensureProfile(knex, profileColumns, service);
  }
  await writeState(knex, {
    inserted: [...inserted].map(([key, id]) => ({ key, id })),
    // Every recorded deactivation was just undone above.
    deactivated: [],
  });
};

// Deactivate, never delete, and write nothing but is_active. A row an admin has
// already deactivated is not counted as ours to reactivate.
exports.down = async function down(knex) {
  const state = await readState(knex);
  const inserted = entries(state?.inserted);
  if (!inserted.length) return;
  const deactivated = entries(state.deactivated);
  for (const { key, id } of inserted) {
    const changed = await knex('services').where({ id, is_active: true }).update({ is_active: false });
    if (changed && !deactivated.some((r) => r.key === key)) deactivated.push({ key, id });
  }
  await writeState(knex, { inserted, deactivated });
};

exports._test = { SERVICES, STATE_KEY };
