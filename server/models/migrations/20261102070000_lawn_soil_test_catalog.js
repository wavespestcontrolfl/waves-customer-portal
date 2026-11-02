/**
 * Lawn Soil Test Service catalog row (owner 2026-11-02: "add a servcie for this ... say we offer soil samples otherwise,
 * but for a cost", then "leave it unpiced for now"): the one `services` row, its completion profile and its
 * `service_taxability` row, so a booked soil test resolves to a scheduled service, a completion lane and an invoice line
 * by KEY, never by display name.
 *
 *   lawn_soil_test   one-time. One lawn sample to the UF/IFAS Extension Soil Testing Laboratory (standard test). Any
 *                    customer can order one; a program lawn that meets a soil-test trigger in the lawn protocol (owner
 *                    2026-10-31) gets its test at no charge.
 *
 * Design (frozen once pushed, so it is spelled out):
 *  - UNPRICED: base_price and the price range are NULL (owner "leave it unpiced for now"); the office sets the price on
 *    each booking, the way One-Time Lawn Care Service is booked. A later price is a new migration that fills the three
 *    cells.
 *  - No engine_keys: no estimate engine line prices it, so the slot-reservation identity link never stamps it from an
 *    estimate. public_quote_selectable false and booking_enabled false: staff book it on a visit; the website quote
 *    tools and the call pipelines do not offer it.
 *  - Completion lane: the generic Service Report (NULL project_type), registered in completion-lane-registry.js
 *    ONE_TIME_GENERIC_BY_DESIGN. The typed one_time_lawn_treatment form records fertilizer, pesticide, amendment or
 *    inspection work and has no sample-collection choice, and a report that auto-sends must record what was done. The
 *    report writer is the assessment module (remaining-service-copy-prompts.js SERVICE_KEY_BINDINGS): a sample is never
 *    reported as a finished lab result.
 *  - NO PRODUCT IS APPLIED: without explicit closeout columns the inference reads a lawn_care name as an application
 *    visit (application log + customer notice), and an honest completion would stay pending forever. The columns are
 *    written with a non-inferred source, so service-closeout-requirements reads them as written. One photo: the labeled
 *    sample bag.
 *  - Tax follows the lawn family (area add-ons, dethatching): services.is_taxable false is the Service Library display
 *    mark (owner rule 2026-10-08: every residential service reads non-taxable; invoice tax comes from
 *    service_taxability). The service_taxability row is lawn_maintenance with residential NOT taxed and commercial
 *    taxed. TaxCalculator matches service_label against the visit's service_type, which is the catalog name, so the
 *    label equals the name.
 *
 * Idempotent and self-healing, same contract as 20261029130000: a pre-existing row (same service_key) is left untouched;
 * a missing profile or tax row is added for an explicitly active service. up() records what it inserted in a
 * system_settings state row; down() removes only that: the service by recorded UUID (retained and deactivated when any
 * scheduled_services / scheduled_service_addons / estimates / service_records row references it), the profile and the tax
 * row by key AND an insertion marker in notes. An operator-edited profile or tax row (marker gone) is never deleted.
 */

const SERVICE = {
  service_key: 'lawn_soil_test',
  name: 'Lawn Soil Test Service',
  short_name: 'Soil Test',
  description: 'One soil sample from your lawn, sent to the University of Florida soil lab for its standard test: pH, lime need and nutrient levels. You get the lab results and our notes on what they mean for your lawn.',
  category: 'lawn_care',
  billing_type: 'one_time',
  frequency: null,
  visits_per_year: null,
  default_duration_minutes: 30,
  min_duration_minutes: 30,
  max_duration_minutes: 45,
  pricing_type: 'variable',
  base_price: null,
  price_range_min: null,
  price_range_max: null,
  pricing_model_key: null,
  is_waveguard: false,
  is_taxable: false,
  tax_service_key: 'lawn_care',
  requires_license: false,
  license_category: null,
  min_tech_skill_level: 1,
  customer_visible: true,
  booking_enabled: false,
  public_quote_selectable: false,
  is_active: true,
  is_archived: false,
  icon: '🧪',
  color: '#16a34a',
  sort_order: 76,
  internal_notes: 'Owner 2026-11-02: any customer can order a soil test; unpriced for now, the office sets the price on each booking. A program lawn that meets a soil-test trigger in the lawn protocol (owner 2026-10-31) gets its test at no charge. UF/IFAS Extension Soil Testing Laboratory standard test (form SL136, check or money order): 10 to 15 cores from the top 4 in, mixed, 1 pint. A paid test sends the customer the lab results and our notes. No product applied: closeout needs no application log and no customer notice.',
};

// Closeout posture: a sampling visit with no product applied. Source is non-inferred, so it is read as written.
const CLOSEOUT = {
  requires_service_report: true,
  requires_application_log: false,
  required_photo_count: 1,
  requires_customer_signature: false,
  requires_customer_notice: false,
  closeout_requirements_source: 'soil_test_no_application_v1',
};

const PROFILE = {
  completion_mode: 'service_report',
  project_type: null,
  delivery_mode: 'auto_send',
  portal_visibility: 'token_only',
  portal_attach_policy: 'recurring_customer',
  followup_policy: 'none',
};

const STATE_KEY = 'migration.20261102070000.state';
const MARKER = '[lawn_soil_test_action=inserted]';
const STATUTE = 'FL §212.05(1)(i)1';

const emptyState = () => ({ services: [], profiles: [], taxability: [] });

async function recordState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!existing) {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
    return;
  }
  // Union with the prior run so a re-run can never shrink what down() may remove.
  let prior = emptyState();
  try { prior = { ...emptyState(), ...JSON.parse(existing.value) }; } catch { /* keep empty */ }
  const byId = new Map();
  for (const entry of [...prior.services, ...state.services]) if (entry && entry.id) byId.set(entry.id, entry);
  await knex('system_settings').where({ key: STATE_KEY }).update({
    value: JSON.stringify({
      services: [...byId.values()],
      profiles: [...new Set([...prior.profiles, ...state.profiles])],
      taxability: [...new Set([...prior.taxability, ...state.taxability])],
    }),
  });
}

async function insertService(knex, inserted) {
  const columns = Object.keys(await knex('services').columnInfo());
  if (await knex('services').where({ service_key: SERVICE.service_key }).first()) {
    console.warn(`[lawn-soil-test-catalog] ${SERVICE.service_key}: services row already exists - leaving untouched`);
    return;
  }
  const raw = { ...SERVICE, ...CLOSEOUT };
  const row = Object.fromEntries(Object.entries(raw).filter(([key]) => columns.includes(key)));
  const returned = await knex('services').insert(row).returning('id');
  const first = Array.isArray(returned) ? returned[0] : returned;
  const newId = first && typeof first === 'object' ? first.id : first;
  if (newId) {
    inserted.services.push({ key: SERVICE.service_key, id: newId });
    console.log(`[lawn-soil-test-catalog] ${SERVICE.service_key}: services row inserted (${newId})`);
  } else {
    console.warn(`[lawn-soil-test-catalog] ${SERVICE.service_key}: inserted but no id returned - row will survive rollback`);
  }
}

async function insertProfile(knex, inserted) {
  const service = await knex('services').where({ service_key: SERVICE.service_key }).first();
  // An admin-deactivated/archived row keeps its posture: explicitly active only.
  if (!service || service.is_active !== true || service.is_archived === true) return;
  if (await knex('service_completion_profiles').where({ service_key: SERVICE.service_key }).first()) return;
  await knex('service_completion_profiles').insert({
    service_key: SERVICE.service_key,
    service_name_snapshot: service.name,
    category: 'lawn_care',
    billing_type: service.billing_type || 'one_time',
    creates_service_record: true,
    default_followup_days: null,
    active: true,
    notes: MARKER,
    ...PROFILE,
  });
  inserted.profiles.push(SERVICE.service_key);
}

async function insertTaxability(knex, inserted) {
  if (await knex('service_taxability').where({ service_key: SERVICE.service_key }).first()) return;
  await knex('service_taxability').insert({
    service_key: SERVICE.service_key,
    // The visit's service_type is the catalog name, and TaxCalculator matches service_label against it.
    service_label: SERVICE.name,
    is_taxable: true,
    tax_category: 'lawn_maintenance',
    fl_statute_ref: STATUTE,
    residential_taxable: false,
    notes: `${MARKER} Lawn family, follows dethatching: residential not taxed, commercial taxed.`,
  });
  inserted.taxability.push(SERVICE.service_key);
}

exports.SERVICE = SERVICE;
exports.CLOSEOUT = CLOSEOUT;
exports.PROFILE = PROFILE;
exports.STATE_KEY = STATE_KEY;
exports.MARKER = MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[lawn-soil-test-catalog] services table absent - skipping');
    return;
  }
  const inserted = emptyState();
  await insertService(knex, inserted);
  if (await knex.schema.hasTable('service_completion_profiles')) await insertProfile(knex, inserted);
  else console.warn('[lawn-soil-test-catalog] service_completion_profiles table absent - skipping profile');
  const hasTaxResidential = (await knex.schema.hasTable('service_taxability'))
    && (await knex.schema.hasColumn('service_taxability', 'residential_taxable'));
  if (hasTaxResidential) await insertTaxability(knex, inserted);
  else console.warn('[lawn-soil-test-catalog] service_taxability (or its residential_taxable column) absent - skipping taxability');
  await recordState(knex, inserted);
};

// Anything that points at the service forces retention (deactivate, keep its profile and tax row).
async function countReferences(knex, entry) {
  const tables = [
    ['service_package_items', 'service_id', entry.id], ['discounts', 'service_key_filter', entry.key],
    ['scheduled_services', 'service_id', entry.id], ['scheduled_service_addons', 'service_id', entry.id],
    ['service_records', 'service_id', entry.id],
  ];
  let refs = 0;
  for (const [table, column, value] of tables) {
    if (await knex.schema.hasTable(table) && await knex.schema.hasColumn(table, column)) {
      refs += (await knex(table).where({ [column]: value }).pluck(column)).length;
    }
  }
  if (await knex.schema.hasTable('service_addons')) {
    refs += (await knex('service_addons').where({ parent_service_id: entry.id }).select('id')).length;
    refs += (await knex('service_addons').where({ addon_service_id: entry.id }).select('id')).length;
  }
  if (await knex.schema.hasTable('leads') && await knex.schema.hasColumn('leads', 'service_key')) {
    refs += (await knex('leads').where({ service_key: entry.key }).pluck('id')).length;
  }
  // An estimate that carries the line names the service by key.
  if (await knex.schema.hasTable('estimates') && await knex.schema.hasColumn('estimates', 'estimate_data')) {
    refs += (await knex('estimates')
      .whereRaw('estimate_data::text LIKE ?', [`%${entry.key}%`])
      .pluck('id')).length;
  }
  // Name-only references: visits scheduled by label before a link existed.
  const row = await knex('services').where({ id: entry.id }).first();
  const aliases = [...new Set([row?.name, row?.short_name].filter(Boolean))];
  for (const alias of aliases) {
    if (await knex.schema.hasTable('scheduled_services')) {
      refs += (await knex('scheduled_services').whereRaw('lower(service_type) = lower(?)', [alias]).pluck('id')).length;
    }
    if (await knex.schema.hasTable('scheduled_service_addons')) {
      refs += (await knex('scheduled_service_addons').whereRaw('lower(service_name) = lower(?)', [alias]).pluck('id')).length;
    }
  }
  return refs;
}

async function removeMarked(knex, table, keys, label, retained) {
  if (!keys.length || !(await knex.schema.hasTable(table))) return;
  for (const key of keys) {
    if (retained.has(key)) continue;
    const row = await knex(table).where({ service_key: key }).first();
    if (!row) continue;
    if (!String(row.notes || '').includes(MARKER)) {
      console.warn(`[lawn-soil-test-catalog] down: ${label} ${key} lacks the insertion marker - admin-replaced, leaving untouched`);
      continue;
    }
    await knex(table).where({ service_key: key }).del();
  }
}

exports.down = async function down(knex) {
  let state = emptyState();
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (row) {
      try { state = { ...emptyState(), ...JSON.parse(row.value) }; } catch (e) {
        console.warn(`[lawn-soil-test-catalog] down: unreadable state row (${e.message}) - removing nothing`);
      }
    }
  }
  const retained = new Set();
  const removableIds = [];
  for (const entry of state.services) {
    if (!entry || !entry.id) continue;
    if ((await countReferences(knex, entry)) > 0) {
      retained.add(entry.key);
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[lawn-soil-test-catalog] down: ${entry.key} (${entry.id}) is referenced - service retained and deactivated`);
    } else {
      removableIds.push(entry.id);
    }
  }
  await removeMarked(knex, 'service_completion_profiles', state.profiles, 'profile', retained);
  await removeMarked(knex, 'service_taxability', state.taxability, 'taxability row', retained);
  if (removableIds.length && (await knex.schema.hasTable('services'))) {
    await knex('services').whereIn('id', removableIds).del();
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
