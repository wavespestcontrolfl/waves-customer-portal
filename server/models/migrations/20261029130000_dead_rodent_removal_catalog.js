/**
 * Dead Rodent Removal & Odor Treatment catalog row (owner approved 2026-10-26, dark behind GATE_DEAD_ANIMAL_REMOVAL):
 * the one `services` row, its completion profile and its `service_taxability` row, so an accepted estimate line
 * resolves to a scheduled service, a completion lane and an invoice line by KEY, never by display name.
 *
 *   rodent_dead_animal_removal   one-time. Priced by priceDeadAnimalRemoval: easy reach 45 min ($169 alone / $119 riding),
 *                                attic search 90 min ($269 alone / $219 riding); inside a wall or ceiling is a custom
 *                                quote. base_price is the easy-reach own-visit price and the range runs riding easy reach
 *                                to alone attic.
 *
 * Design (frozen once pushed, so it is spelled out):
 *  - engine_keys ['rodent_dead_animal_removal'] is the engine's own line key, so the slot-reservation identity link
 *    (containment on engine_keys) stamps service_id on the booked visit. The tier minutes (45 / 90) ride the sold row as a
 *    duration floor (estimate-slot-availability deadAnimalProfileFields); default_duration_minutes is the easy-reach 45.
 *  - public_quote_selectable false and booking_enabled false: staff sell it on an estimate; the website and the call
 *    pipelines do not offer it in this change. It is not in the public price feed.
 *  - Completion lane: the typed rodent_sanitation form (service_report, project_type rodent_sanitation, auto_send, the
 *    same posture the graduated rodent_sanitation_* keys carry since 20260712200000). The form's work chips already
 *    include "Removed dead rodent" and "Deodorized affected areas". Typed profiles need no completion-lane-registry entry;
 *    visit-facts-contract.js lists the key under rodent_sanitation.
 *  - NO PESTICIDE APPLICATION is required: the closeout columns mirror rodent_inspection (a labor and cleanup visit, no
 *    application log, no customer notice), stamped with a non-inferred source so service-closeout-requirements reads them
 *    as written. Without them the name's word "Treatment" would infer an application log, and an honest completion would
 *    stay pending forever on no_application_rows. requires_license true / license_category 'GHP' mirror rodent_inspection.
 *  - Tax follows the rodent family (pest control, tax_service_key 'pest_control'). services.is_taxable is false, the
 *    Service Library display mark (owner rule 2026-10-08: every residential service reads non-taxable; invoice tax comes
 *    from service_taxability). The service_taxability row is pest_control with residential NOT taxed and commercial taxed.
 *    rodent_sanitation_* has no taxability row of its own (the tax lookup falls through to the residential default), so
 *    this row states the same answer explicitly. TaxCalculator matches service_label against the visit's service_type,
 *    which is the catalog name, so the label equals the name.
 *  - No service_discount_rules row: the line is discountable like the other rodent one-time lines (the recurring-customer
 *    perk), which is the engine default for a key with no rule.
 *
 * Idempotent and self-healing, same contract as 20261023100000: a pre-existing row (same service_key) is left untouched;
 * a missing profile or tax row is added for an explicitly active service. up() records what it inserted in a
 * system_settings state row; down() removes only that: the service by recorded UUID (retained and deactivated when any
 * scheduled_services / scheduled_service_addons / estimates / service_records row references it), the profile and the tax
 * row by key AND an insertion marker in notes. An operator-edited profile or tax row (marker gone) is never deleted.
 */

const SERVICE = {
  service_key: 'rodent_dead_animal_removal',
  name: 'Dead Rodent Removal & Odor Treatment',
  short_name: 'Dead Rodent Removal',
  description: 'Find and remove a dead rodent, then clean and treat the spot to break down the odor at its source. Priced by how hard it is to reach: easy reach, attic search, or a custom quote when it is inside a wall or ceiling.',
  category: 'rodent',
  billing_type: 'one_time',
  frequency: null,
  visits_per_year: null,
  default_duration_minutes: 45,
  min_duration_minutes: 45,
  max_duration_minutes: 90,
  pricing_type: 'variable',
  base_price: 169.0,
  price_range_min: 119.0,
  price_range_max: 269.0,
  pricing_model_key: null,
  is_waveguard: false,
  is_taxable: false,
  tax_service_key: 'pest_control',
  requires_license: true,
  license_category: 'GHP',
  min_tech_skill_level: 1,
  customer_visible: true,
  booking_enabled: false,
  public_quote_selectable: false,
  is_active: true,
  is_archived: false,
  icon: '🐀',
  color: '#78716c',
  sort_order: 41,
  engine_keys: ['rodent_dead_animal_removal'],
  internal_notes: 'Priced by priceDeadAnimalRemoval; engine_keys rodent_dead_animal_removal. Easy reach 45 min $169 alone / $119 riding; attic search 90 min $269 alone / $219 riding; in a wall or ceiling = custom quote. No pesticide application: closeout mirrors rodent_inspection (no application log, no notice). Dark behind GATE_DEAD_ANIMAL_REMOVAL; staff-sold only.',
};

// Closeout posture: a cleanup visit with no product applied. Source is non-inferred, so it is read as written.
const CLOSEOUT = {
  requires_service_report: true,
  requires_application_log: false,
  required_photo_count: 2,
  requires_customer_signature: false,
  requires_customer_notice: false,
  closeout_requirements_source: 'dead_animal_no_application_v1',
};

const PROFILE = {
  completion_mode: 'service_report',
  project_type: 'rodent_sanitation',
  delivery_mode: 'auto_send',
  portal_visibility: 'customer_portal',
  portal_attach_policy: 'active_portal_customer',
  followup_policy: 'none',
};

const STATE_KEY = 'migration.20261029130000.state';
const MARKER = '[dead_rodent_removal_action=inserted]';
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
    console.warn(`[dead-rodent-removal-catalog] ${SERVICE.service_key}: services row already exists - leaving untouched`);
    return;
  }
  const raw = { ...SERVICE, ...CLOSEOUT };
  const row = Object.fromEntries(Object.entries(raw).filter(([key]) => columns.includes(key)));
  if (row.engine_keys) row.engine_keys = JSON.stringify(row.engine_keys);
  const returned = await knex('services').insert(row).returning('id');
  const first = Array.isArray(returned) ? returned[0] : returned;
  const newId = first && typeof first === 'object' ? first.id : first;
  if (newId) {
    inserted.services.push({ key: SERVICE.service_key, id: newId });
    console.log(`[dead-rodent-removal-catalog] ${SERVICE.service_key}: services row inserted (${newId})`);
  } else {
    console.warn(`[dead-rodent-removal-catalog] ${SERVICE.service_key}: inserted but no id returned - row will survive rollback`);
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
    category: 'rodent',
    billing_type: service.billing_type || 'one_time',
    creates_service_record: true,
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
    tax_category: 'pest_control',
    fl_statute_ref: STATUTE,
    residential_taxable: false,
    notes: `${MARKER} Pest control family: residential not taxed, commercial taxed.`,
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
    console.warn('[dead-rodent-removal-catalog] services table absent - skipping');
    return;
  }
  const inserted = emptyState();
  await insertService(knex, inserted);
  if (await knex.schema.hasTable('service_completion_profiles')) await insertProfile(knex, inserted);
  else console.warn('[dead-rodent-removal-catalog] service_completion_profiles table absent - skipping profile');
  const hasTaxResidential = (await knex.schema.hasTable('service_taxability'))
    && (await knex.schema.hasColumn('service_taxability', 'residential_taxable'));
  if (hasTaxResidential) await insertTaxability(knex, inserted);
  else console.warn('[dead-rodent-removal-catalog] service_taxability (or its residential_taxable column) absent - skipping taxability');
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
  // An estimate that carries the line (stored result / engine inputs) names the service by key or label.
  if (await knex.schema.hasTable('estimates') && await knex.schema.hasColumn('estimates', 'estimate_data')) {
    refs += (await knex('estimates')
      .whereRaw('estimate_data::text LIKE ?', [`%${entry.key}%`])
      .pluck('id')).length;
  }
  // Name-only references: visits scheduled by label before a link existed.
  const row = await knex('services').where({ id: entry.id }).first();
  const aliases = [...new Set([row?.name, row?.name ? `${row.name} Service` : null, row?.short_name].filter(Boolean))];
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
      console.warn(`[dead-rodent-removal-catalog] down: ${label} ${key} lacks the insertion marker - admin-replaced, leaving untouched`);
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
        console.warn(`[dead-rodent-removal-catalog] down: unreadable state row (${e.message}) - removing nothing`);
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
      console.warn(`[dead-rodent-removal-catalog] down: ${entry.key} (${entry.id}) is referenced - service retained and deactivated`);
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
