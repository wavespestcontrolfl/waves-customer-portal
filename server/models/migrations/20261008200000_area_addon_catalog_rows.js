/**
 * Area add-on catalog rows: the six one-time add-on treatments the estimate
 * engine prices behind GATE_AREA_ADDONS (owner rulings 2026-10-08), each with
 * its own `services` row, generic completion profile and `service_taxability`
 * row, so an accepted add-on resolves to a scheduled service and an invoice
 * line by KEY, never by display name.
 *
 * Design (frozen once pushed, so it is spelled out):
 *  - service_key = `area_addon_<engine addOnKey>`. The engine emits ONE raw
 *    service key ('area_addon') for all six, so `engine_keys` cannot name one
 *    row; the engine line and the mapped row carry `catalogServiceKey`
 *    instead, and the accept path stamps service_id by that exact key
 *    (slot-reservation catalogLinkForProfile). engine_keys stays NULL.
 *  - name = EXACTLY the pricer's line name (constants.js AREA_ADDONS), so the
 *    scheduled visit's label, the invoice line and the tax label lookup
 *    (TaxCalculator matches service_label against the visit's service_type)
 *    all read the same words. short_name = the same name where it fits 50
 *    characters.
 *  - Tax follows dethatching (owner ruling): is_taxable true, residential NOT
 *    taxed (residential_taxable false; InvoiceService also forces residential
 *    tax to zero), commercial taxed. Web sweep is pest control
 *    (tax_category 'pest_control'); the other five are lawn maintenance
 *    ('lawn_maintenance'). Statute reference mirrors the siblings.
 *  - Completion lane: generic Service Report (NULL project_type), the same
 *    posture as the three mechanical lawn add-ons and fire_ant: the typed
 *    one_time_lawn_treatment form has no choices for bed, hardscape, fire-ant
 *    broadcast or web work. Registered in ONE_TIME_GENERIC_BY_DESIGN.
 *  - Durations: the largest tier's engine on-site minutes rounded up to 5 and
 *    never below 30 (scheduling floor); the booked visit never goes below
 *    the engine's minutes for the sold tier (profile durationMinutes).
 *  - Price fields are engine outputs at this commit (own visit, smallest to
 *    largest tier; same visit lowest). No recurring or WaveGuard price.
 *  - booking_enabled false and public_quote_selectable left at its false
 *    default: staff sell these on an estimate; the website does not offer
 *    them.
 *
 * Idempotent and self-healing, same contract as 20260808080000: a pre-existing
 * row (same service_key) is left untouched; a missing profile or taxability
 * row is added for an explicitly active service. up() records what it
 * inserted in a system_settings state row; down() removes only that: services
 * by recorded UUID (retained and deactivated when anything references them),
 * profiles and taxability rows by key AND an insertion marker in notes.
 */

const SERVICES = [
  {
    service_key: 'area_addon_bed_pre_emergent',
    name: 'Bed Pre-Emergent Weed Control',
    short_name: 'Bed Pre-Emergent',
    description: 'One pre-emergent weed-control application to landscape beds, priced by treated bed area (up to 1,000, 2,000 or 3,500 sq ft).',
    category: 'lawn_care',
    default_duration_minutes: 35, // 6 + 8/1,000 sq ft at the 3,500 tier = 34 min on site
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    base_price: 99.0, // priceAreaAddOn('bed_pre_emergent', { areaSqFt: 1000 })
    price_range_min: 69.0, // same-visit, smallest tier
    price_range_max: 199.0, // own visit, largest tier
    pricing_model_key: 'bed_sqft',
    tax_category: 'lawn_maintenance',
    icon: '🌱',
    sort_order: 70,
    internal_notes: 'Snapshot 2.5TG, label 600 lb/acre per 12 months (two applications a year). Version 1 sells one application per estimate; a second is a new estimate.',
  },
  {
    service_key: 'area_addon_lawn_insect_spot',
    name: 'Lawn Insect Spot Treatment',
    short_name: 'Lawn Insect Spot',
    description: 'One insect spot treatment for damaged St. Augustine turf and its green edge, priced by treated area (up to 1,000, 2,000 or 3,500 sq ft).',
    category: 'lawn_care',
    default_duration_minutes: 30, // 8 + 6/1,000 sq ft at the 3,500 tier = 29 min on site
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    base_price: 79.0, // priceAreaAddOn('lawn_insect_spot', { areaSqFt: 1000, grassType: 'st_augustine' })
    price_range_min: 49.0,
    price_range_max: 109.0,
    pricing_model_key: 'sqft_lawn',
    tax_category: 'lawn_maintenance',
    icon: '🐛',
    sort_order: 71,
    internal_notes: 'Arena 50 WDG at the Florida 2(ee) rate (sheet on file in Staff documents; the applicator carries it). St. Augustine only: any other or unknown grass is a custom quote from the pricer.',
  },
  {
    service_key: 'area_addon_fire_ant_yard',
    name: 'Fire Ant Yard Treatment',
    short_name: 'Fire Ant Yard',
    description: 'One broadcast fire ant treatment across the lawn, priced by treated area (up to 3,000, 5,000 or 8,000 sq ft).',
    category: 'lawn_care',
    default_duration_minutes: 30, // 6 + 2.5/1,000 sq ft at the 8,000 tier = 26 min on site
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    base_price: 99.0, // priceAreaAddOn('fire_ant_yard', { areaSqFt: 3000 })
    price_range_min: 69.0,
    price_range_max: 169.0,
    pricing_model_key: 'sqft_lawn',
    tax_category: 'lawn_maintenance',
    icon: '🐜',
    sort_order: 72,
    internal_notes: 'Topchoice at 2 lb/1,000 sq ft, once a year. Not the catalog fire_ant row (a pest-family spot service).',
  },
  {
    service_key: 'area_addon_lawn_insect_preventive',
    name: 'Yearly Lawn Insect Preventive',
    short_name: 'Lawn Insect Preventive',
    description: 'One yearly preventive insect treatment across the lawn, priced by treated area (up to 3,000, 5,000 or 8,000 sq ft).',
    category: 'lawn_care',
    default_duration_minutes: 30, // 8 + 2.5/1,000 sq ft at the 8,000 tier = 28 min on site
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    base_price: 99.0, // priceAreaAddOn('lawn_insect_preventive', { areaSqFt: 3000 })
    price_range_min: 69.0,
    price_range_max: 149.0,
    pricing_model_key: 'sqft_lawn',
    tax_category: 'lawn_maintenance',
    icon: '🛡️',
    sort_order: 73,
    internal_notes: 'Acelepryn at 0.184 fl oz/1,000 sq ft, once a year (April).',
  },
  {
    service_key: 'area_addon_hardscape_weed',
    name: 'Shell, Rock & Paver Weed Control',
    short_name: 'Hardscape Weed',
    description: 'One weed-control application to shell, rock beds, pavers and fence lines, priced by treated area (up to 1,000, 2,000 or 3,500 sq ft).',
    category: 'lawn_care',
    default_duration_minutes: 30, // 8 + 6/1,000 sq ft at the 3,500 tier = 29 min on site
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    base_price: 119.0, // priceAreaAddOn('hardscape_weed', { areaSqFt: 1000 })
    price_range_min: 89.0,
    price_range_max: 259.0,
    pricing_model_key: 'sqft_lawn',
    tax_category: 'lawn_maintenance',
    icon: '🪨',
    sort_order: 74,
    internal_notes: 'Roundup QuikPro SC Total at the label rate, 16 fl oz/1,000 sq ft; label limit 32 fl oz/1,000 per 12 months. Hard surfaces and bare ground only (6-month soil residual).',
  },
  {
    service_key: 'area_addon_web_sweep',
    name: 'Web Sweep',
    short_name: 'Web Sweep',
    description: 'One web sweep of the pool cage, lanai and eaves, a flat labor-only job.',
    category: 'pest_control',
    default_duration_minutes: 30, // 25 min on site; floor 30
    min_duration_minutes: 30,
    max_duration_minutes: 90,
    base_price: 89.0, // priceAreaAddOn('web_sweep')
    price_range_min: 59.0,
    price_range_max: 89.0,
    pricing_model_key: 'flat',
    tax_category: 'pest_control',
    icon: '🕸️',
    sort_order: 75,
    internal_notes: 'Labor only, no product. Pest control family for tax and the invoice label.',
  },
];

// Fields every row shares. The tax posture mirrors dethatching (is_taxable
// true, tax_service_key = the family); the services row carries no tax_category
// (siblings do not either), the taxability row below does.
function fullRow({ tax_category: _taxCategory, ...svc }) {
  return {
    ...svc,
    billing_type: 'one_time',
    pricing_type: 'variable',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: svc.category,
    requires_license: false,
    min_tech_skill_level: 1,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    color: svc.category === 'pest_control' ? '#dc2626' : '#16a34a',
  };
}

const STATE_KEY = 'migration.20261008200000.state';
const MARKER = '[area_addon_catalog_action=inserted]';
const STATUTE = 'FL §212.05(1)(i)1';

async function recordState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!existing) {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
    return;
  }
  // Union with the prior run so a re-run can never shrink what down() may remove.
  let prior = { services: [], profiles: [], taxability: [] };
  try { prior = { services: [], profiles: [], taxability: [], ...JSON.parse(existing.value) }; } catch { /* keep empty */ }
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

async function insertServices(knex, inserted) {
  for (const raw of SERVICES) {
    const svc = fullRow(raw);
    if (await knex('services').where({ service_key: svc.service_key }).first()) {
      console.warn(`[area-addon-catalog] ${svc.service_key}: services row already exists - leaving untouched`);
      continue;
    }
    const returned = await knex('services').insert(svc).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) inserted.services.push({ key: svc.service_key, id: newId });
    else console.warn(`[area-addon-catalog] ${svc.service_key}: inserted but no id returned - row will survive rollback`);
  }
}

async function insertProfiles(knex, inserted) {
  for (const raw of SERVICES) {
    const service = await knex('services').where({ service_key: raw.service_key }).first();
    // An admin-deactivated/archived row keeps its posture: explicitly active only.
    if (!service || service.is_active !== true || service.is_archived === true) continue;
    if (await knex('service_completion_profiles').where({ service_key: raw.service_key }).first()) continue;
    await knex('service_completion_profiles').insert({
      service_key: raw.service_key,
      service_name_snapshot: service.name,
      category: service.category,
      billing_type: service.billing_type || 'one_time',
      completion_mode: 'service_report',
      project_type: null,
      delivery_mode: 'auto_send',
      creates_service_record: true,
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: 'none',
      default_followup_days: null,
      active: true,
      notes: MARKER,
    });
    inserted.profiles.push(raw.service_key);
  }
}

async function insertTaxability(knex, inserted) {
  for (const raw of SERVICES) {
    if (await knex('service_taxability').where({ service_key: raw.service_key }).first()) continue;
    await knex('service_taxability').insert({
      service_key: raw.service_key,
      // The visit's service_type is the catalog name, and TaxCalculator matches
      // service_label against it: keep the two identical.
      service_label: raw.name,
      is_taxable: true,
      tax_category: raw.tax_category,
      fl_statute_ref: STATUTE,
      // Residential is not taxed; the two one-shot residential migrations
      // (20260401000103, 20260414000022) only updated rows that existed then.
      residential_taxable: false,
      notes: `${MARKER} Follows dethatching: residential not taxed, commercial taxed.`,
    });
    inserted.taxability.push(raw.service_key);
  }
}

exports.SERVICES = SERVICES;
exports.STATE_KEY = STATE_KEY;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[area-addon-catalog] services table absent - skipping');
    return;
  }
  const inserted = { services: [], profiles: [], taxability: [] };
  await insertServices(knex, inserted);
  if (await knex.schema.hasTable('service_completion_profiles')) await insertProfiles(knex, inserted);
  else console.warn('[area-addon-catalog] service_completion_profiles table absent - skipping profiles');
  const hasTaxResidential = (await knex.schema.hasTable('service_taxability'))
    && (await knex.schema.hasColumn('service_taxability', 'residential_taxable'));
  if (hasTaxResidential) await insertTaxability(knex, inserted);
  else console.warn('[area-addon-catalog] service_taxability (or its residential_taxable column) absent - skipping taxability');
  await recordState(knex, inserted);
};

// Anything that points at a service forces retention (deactivate, keep links).
async function countReferences(knex, entry) {
  const tables = [
    ['service_addons', 'parent_service_id', entry.id], ['service_addons', 'addon_service_id', entry.id],
    ['service_package_items', 'service_id', entry.id], ['service_discount_rules', 'service_key', entry.key],
    ['discounts', 'service_key_filter', entry.key], ['scheduled_services', 'service_id', entry.id],
    ['scheduled_service_addons', 'service_id', entry.id], ['service_records', 'service_id', entry.id],
  ];
  let refs = 0;
  for (const [table, column, value] of tables) {
    if (await knex.schema.hasTable(table)) refs += (await knex(table).where({ [column]: value }).pluck(column)).length;
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
      console.warn(`[area-addon-catalog] down: ${label} ${key} lacks the insertion marker - admin-replaced, leaving untouched`);
      continue;
    }
    await knex(table).where({ service_key: key }).del();
  }
}

exports.down = async function down(knex) {
  let state = { services: [], profiles: [], taxability: [] };
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (row) {
      try { state = { services: [], profiles: [], taxability: [], ...JSON.parse(row.value) }; } catch (e) {
        console.warn(`[area-addon-catalog] down: unreadable state row (${e.message}) - removing nothing`);
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
      console.warn(`[area-addon-catalog] down: ${entry.key} (${entry.id}) is referenced - service retained and deactivated`);
    } else {
      removableIds.push(entry.id);
    }
  }
  // A retained service keeps its profile and its tax row: visits that forced
  // retention still complete and invoice through them.
  await removeMarked(knex, 'service_completion_profiles', state.profiles, 'profile', retained);
  await removeMarked(knex, 'service_taxability', state.taxability, 'taxability row', retained);
  if (removableIds.length && (await knex.schema.hasTable('services'))) {
    await knex('services').whereIn('id', removableIds).del();
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
