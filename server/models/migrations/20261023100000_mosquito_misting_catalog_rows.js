/**
 * Mosquito misting system catalog rows (misting PR 2a, GATE_MOSQUITO_MISTING): the three catalog identities an accepted
 * misting estimate converts into, so the install, the monthly service plan and a refill each resolve to a scheduled service,
 * a completion profile, a tax row and an invoice line by KEY, never by display name.
 *
 *   mosquito_misting_install   one-time install (2 techs, about one day). Priced by priceMosquitoMisting per tier, nozzle and
 *                              riser count; base_price is the Smart list and the range runs Essential list to open-ended.
 *   mosquito_misting_service   the monthly service plan: 12 applications a year, one fixed price per application
 *                              (MOSQUITO_MISTING.plan.monthly, 59 at the draft price list).
 *   mosquito_misting_refill    a refill add-on billed per refill application when the tech refills the tank; the solution
 *                              tier sets the price (Standard 129, Natural 219, Premium 319). base_price is the Standard
 *                              price; a service-plan visit can carry it as a scheduled_service_addons row.
 *
 * The lead-only design-visit row mosquito_misting_system (20260924000020) is NOT touched and stays the only key
 * isMistingDesignConsultation recognizes.
 *
 * Design (frozen once pushed, so it is spelled out):
 *  - public_quote_selectable false: the engine prices these through the estimate, never the public quote form.
 *    booking_enabled false: the install needs the design visit first and the plan is created by estimate conversion.
 *    is_waveguard false: the misting line is not a WaveGuard tier service and takes no percent discount.
 *  - Tax follows mosquito (pest control): is_taxable true, tax_service_key 'mosquito'; the service_taxability row is
 *    pest_control with residential not taxed and commercial taxed, like the web sweep add-on.
 *  - engine_keys: install -> mosquito_misting_installation, service -> mosquito_misting (the engine's own line keys), so the
 *    slot-reservation identity link stamps the catalog row. The refill has no engine line, so it carries none.
 *  - Completion lane: install and service are the generic Service Report (service_report, NULL project_type, auto_send,
 *    creates_service_record), registered in completion-lane-registry.js (one-time and recurring generic by design). The
 *    refill is a billing rider on its parent visit (internal_only, delivery disabled), registered in BILLING_RIDER_KEYS.
 *  - service_addons: the refill is linked as an add-on of the service plan (addon_price NULL = the add-on's own price), when
 *    that table exists.
 *  - service_discount_rules: all three are excluded from percentage discounts and are not tier qualifiers, mirroring
 *    constants.js WAVEGUARD.excludedFromPercentDiscount.mosquito_misting.
 *
 * Idempotent and self-healing, same contract as 20260924000020 and 20261008200000: a pre-existing row (same service_key) is
 * left untouched; a missing profile, tax row or rule is added for an explicitly active service. up() records what it inserted
 * in a system_settings state row; down() removes only that: services by recorded UUID (retained and deactivated when anything
 * references them), profiles, tax rows and rules by key AND an insertion marker in notes, the add-on link by recorded id.
 * The prices are the draft list (dealer cost unknown); they are inlined here because a pushed migration is frozen, and a test
 * pins them equal to constants.js MOSQUITO_MISTING.
 */

const SERVICES = [
  {
    service_key: 'mosquito_misting_install',
    name: 'Mosquito Misting System Installation',
    short_name: 'Misting Install',
    description: 'Installation of an automatic mosquito misting system: pump or tankless unit, tubing, nozzles and risers, calibration and a customer walkthrough. Priced by system type, nozzle count and riser count on the estimate.',
    category: 'mosquito',
    billing_type: 'one_time',
    frequency: null,
    visits_per_year: null,
    default_duration_minutes: 480,
    min_duration_minutes: 240,
    max_duration_minutes: 720,
    pricing_type: 'variable',
    base_price: 4595.0,
    price_range_min: 3795.0,
    price_range_max: null,
    pricing_model_key: null,
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'mosquito',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: false,
    public_quote_selectable: false,
    is_active: true,
    is_archived: false,
    icon: '🦟',
    color: '#0ea5e9',
    sort_order: 25,
    engine_keys: ['mosquito_misting_installation'],
    internal_notes: 'Priced by priceMosquitoMisting; engine_keys mosquito_misting_installation. Smart list 4,595, Essential list 3,795 (draft; dealer cost unknown). Two techs, about one day. Follows the design visit (mosquito_misting_system).',
  },
  {
    service_key: 'mosquito_misting_service',
    name: 'Mosquito Misting Service Plan',
    short_name: 'Misting Plan',
    description: 'Monthly service plan for an automatic mosquito misting system: 12 service applications a year. Refills are billed per refill application.',
    category: 'mosquito',
    billing_type: 'recurring',
    frequency: 'monthly',
    visits_per_year: 12,
    default_duration_minutes: 30,
    min_duration_minutes: 20,
    max_duration_minutes: 60,
    pricing_type: 'fixed',
    base_price: 59.0,
    price_range_min: null,
    price_range_max: null,
    pricing_model_key: null,
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'mosquito',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: false,
    public_quote_selectable: false,
    is_active: true,
    is_archived: false,
    icon: '🦟',
    color: '#0ea5e9',
    sort_order: 26,
    engine_keys: ['mosquito_misting'],
    internal_notes: 'Engine key mosquito_misting; $59 per application, 12 applications a year (draft). Not a WaveGuard tier service. Created by estimate conversion, not booked online.',
  },
  {
    service_key: 'mosquito_misting_refill',
    name: 'Mosquito Misting System Refill',
    short_name: 'Misting Refill',
    description: 'Refill of the misting system tank with the customer\'s chosen solution, billed per refill application.',
    category: 'mosquito',
    billing_type: 'one_time',
    frequency: null,
    visits_per_year: null,
    default_duration_minutes: 20,
    min_duration_minutes: 10,
    max_duration_minutes: 45,
    pricing_type: 'variable',
    base_price: 129.0,
    price_range_min: 129.0,
    price_range_max: 319.0,
    pricing_model_key: null,
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'mosquito',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: false,
    booking_enabled: false,
    public_quote_selectable: false,
    is_active: true,
    is_archived: false,
    icon: '🦟',
    color: '#0ea5e9',
    sort_order: 27,
    internal_notes: 'Billed per refill application when the tech refills the tank; the solution tier sets the price (Standard 129, Natural 219, Premium 319; draft). base_price is the Standard price. Attachable to a service-plan visit as an add-on (scheduled_service_addons).',
  },
];

// Billing rider: the refill is an invoice line on its parent visit with no report of its own (completion-lane-registry.js
// BILLING_RIDER_KEYS). The install and the plan are the generic Service Report.
const PROFILES = {
  mosquito_misting_install: { completion_mode: 'service_report', delivery_mode: 'auto_send', portal_visibility: 'token_only', portal_attach_policy: 'recurring_customer' },
  mosquito_misting_service: { completion_mode: 'service_report', delivery_mode: 'auto_send', portal_visibility: 'token_only', portal_attach_policy: 'recurring_customer' },
  mosquito_misting_refill: { completion_mode: 'internal_only', delivery_mode: 'disabled', portal_visibility: 'token_only', portal_attach_policy: 'recurring_customer' },
};

const STATE_KEY = 'migration.20261023100000.state';
const MARKER = '[mosquito_misting_catalog_action=inserted]';
const STATUTE = 'FL §212.05(1)(i)1';
const RULE_NOTES = `${MARKER} Misting system lines are excluded from percentage discounts and are not WaveGuard tier qualifiers.`;

const emptyState = () => ({ services: [], profiles: [], taxability: [], rules: [], addons: [] });

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
  const addonById = new Map();
  for (const entry of [...prior.addons, ...state.addons]) if (entry && entry.id) addonById.set(entry.id, entry);
  await knex('system_settings').where({ key: STATE_KEY }).update({
    value: JSON.stringify({
      services: [...byId.values()],
      profiles: [...new Set([...prior.profiles, ...state.profiles])],
      taxability: [...new Set([...prior.taxability, ...state.taxability])],
      rules: [...new Set([...prior.rules, ...state.rules])],
      addons: [...addonById.values()],
    }),
  });
}

async function insertServices(knex, inserted) {
  const columns = Object.keys(await knex('services').columnInfo());
  for (const raw of SERVICES) {
    if (await knex('services').where({ service_key: raw.service_key }).first()) {
      console.warn(`[mosquito-misting-conversion-catalog] ${raw.service_key}: services row already exists - leaving untouched`);
      continue;
    }
    const row = Object.fromEntries(Object.entries(raw).filter(([key]) => columns.includes(key)));
    if (row.engine_keys) row.engine_keys = JSON.stringify(row.engine_keys);
    const returned = await knex('services').insert(row).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: raw.service_key, id: newId });
      console.log(`[mosquito-misting-conversion-catalog] ${raw.service_key}: services row inserted (${newId})`);
    } else {
      console.warn(`[mosquito-misting-conversion-catalog] ${raw.service_key}: inserted but no id returned - row will survive rollback`);
    }
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
      project_type: null,
      creates_service_record: true,
      followup_policy: 'none',
      default_followup_days: null,
      active: true,
      notes: MARKER,
      ...PROFILES[raw.service_key],
    });
    inserted.profiles.push(raw.service_key);
  }
}

async function insertTaxability(knex, inserted) {
  for (const raw of SERVICES) {
    if (await knex('service_taxability').where({ service_key: raw.service_key }).first()) continue;
    await knex('service_taxability').insert({
      service_key: raw.service_key,
      // The visit's service_type is the catalog name, and TaxCalculator matches service_label against it.
      service_label: raw.name,
      is_taxable: true,
      tax_category: 'pest_control',
      fl_statute_ref: STATUTE,
      residential_taxable: false,
      notes: `${MARKER} Pest control family: residential not taxed, commercial taxed.`,
    });
    inserted.taxability.push(raw.service_key);
  }
}

async function insertRules(knex, inserted) {
  for (const raw of SERVICES) {
    if (await knex('service_discount_rules').where({ service_key: raw.service_key }).first('service_key')) continue;
    await knex('service_discount_rules').insert({
      service_key: raw.service_key,
      tier_qualifier: false,
      max_discount_pct: null,
      flat_credit: null,
      flat_credit_min_tier: null,
      exclude_from_pct_discount: true,
      notes: RULE_NOTES,
      updated_at: knex.fn.now(),
    }).onConflict('service_key').ignore();
    inserted.rules.push(raw.service_key);
  }
}

// The refill is an add-on of the service plan (so the schedule's add-on picker offers it on a plan visit).
async function linkRefillAddon(knex, inserted) {
  const plan = await knex('services').where({ service_key: 'mosquito_misting_service' }).first('id');
  const refill = await knex('services').where({ service_key: 'mosquito_misting_refill' }).first('id');
  if (!plan || !refill) return;
  if (await knex('service_addons').where({ parent_service_id: plan.id, addon_service_id: refill.id }).first('id')) return;
  const returned = await knex('service_addons').insert({
    parent_service_id: plan.id, addon_service_id: refill.id, is_default: false, addon_price: null, sort_order: 0,
  }).returning('id');
  const first = Array.isArray(returned) ? returned[0] : returned;
  const id = first && typeof first === 'object' ? first.id : first;
  if (id) inserted.addons.push({ id, parent: plan.id, addon: refill.id });
}

exports.SERVICES = SERVICES;
exports.PROFILES = PROFILES;
exports.STATE_KEY = STATE_KEY;
exports.MARKER = MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[mosquito-misting-conversion-catalog] services table absent - skipping');
    return;
  }
  const inserted = emptyState();
  await insertServices(knex, inserted);
  if (await knex.schema.hasTable('service_completion_profiles')) await insertProfiles(knex, inserted);
  else console.warn('[mosquito-misting-conversion-catalog] service_completion_profiles table absent - skipping profiles');
  const hasTaxResidential = (await knex.schema.hasTable('service_taxability'))
    && (await knex.schema.hasColumn('service_taxability', 'residential_taxable'));
  if (hasTaxResidential) await insertTaxability(knex, inserted);
  else console.warn('[mosquito-misting-conversion-catalog] service_taxability (or its residential_taxable column) absent - skipping taxability');
  if (await knex.schema.hasTable('service_discount_rules')) await insertRules(knex, inserted);
  if (await knex.schema.hasTable('service_addons')) await linkRefillAddon(knex, inserted);
  await recordState(knex, inserted);
};

// Anything that points at a service forces retention (deactivate, keep links). The add-on link THIS migration made is
// not a reference that blocks the removal; every other add-on link is.
async function countReferences(knex, entry, ownedAddonIds) {
  const tables = [
    ['service_package_items', 'service_id', entry.id], ['service_discount_rules', 'service_key', entry.key],
    ['discounts', 'service_key_filter', entry.key], ['scheduled_services', 'service_id', entry.id],
    ['scheduled_service_addons', 'service_id', entry.id], ['service_records', 'service_id', entry.id],
  ];
  let refs = 0;
  for (const [table, column, value] of tables) {
    if (table === 'service_discount_rules') continue; // our own marked rule is removed with the row; an edited one is handled below
    if (await knex.schema.hasTable(table)) refs += (await knex(table).where({ [column]: value }).pluck(column)).length;
  }
  if (await knex.schema.hasTable('service_addons')) {
    const links = [
      ...(await knex('service_addons').where({ parent_service_id: entry.id }).select('id')),
      ...(await knex('service_addons').where({ addon_service_id: entry.id }).select('id')),
    ];
    refs += links.filter((link) => !ownedAddonIds.has(link.id)).length;
  }
  if (await knex.schema.hasTable('leads') && await knex.schema.hasColumn('leads', 'service_key')) {
    refs += (await knex('leads').where({ service_key: entry.key }).pluck('id')).length;
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
      console.warn(`[mosquito-misting-conversion-catalog] down: ${label} ${key} lacks the insertion marker - admin-replaced, leaving untouched`);
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
        console.warn(`[mosquito-misting-conversion-catalog] down: unreadable state row (${e.message}) - removing nothing`);
      }
    }
  }
  const ownedAddonIds = new Set((state.addons || []).map((entry) => entry && entry.id).filter(Boolean));
  const retained = new Set();
  const removableIds = [];
  for (const entry of state.services) {
    if (!entry || !entry.id) continue;
    if ((await countReferences(knex, entry, ownedAddonIds)) > 0) {
      retained.add(entry.key);
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[mosquito-misting-conversion-catalog] down: ${entry.key} (${entry.id}) is referenced - service retained and deactivated`);
    } else {
      removableIds.push(entry.id);
    }
  }
  // The two endpoints of a preserved add-on link are ONE unit: both service_addons foreign keys are ON DELETE CASCADE, so deleting
  // an endpoint would delete the link a retained endpoint still keeps. If either endpoint is retained, retain both (the other is
  // deactivated with it, its profile, tax row and rule stay) and say so.
  if (ownedAddonIds.size) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const link of state.addons || []) {
        if (!link || !link.parent || !link.addon) continue;
        const parent = state.services.find((entry) => entry && entry.id === link.parent);
        const addon = state.services.find((entry) => entry && entry.id === link.addon);
        if (!parent || !addon) continue;
        const [kept, pulled] = retained.has(parent.key) && !retained.has(addon.key) ? [parent, addon]
          : (retained.has(addon.key) && !retained.has(parent.key) ? [addon, parent] : [null, null]);
        if (!kept) continue;
        retained.add(pulled.key);
        const at = removableIds.indexOf(pulled.id);
        if (at >= 0) removableIds.splice(at, 1);
        await knex('services').where({ id: pulled.id }).update({ is_active: false });
        console.warn(`[mosquito-misting-conversion-catalog] down: ${pulled.key} (${pulled.id}) is the other end of the add-on link kept by ${kept.key} - service retained and deactivated so the link survives`);
        changed = true;
      }
    }
  }
  // The add-on link goes only when both of its services go; a retained service keeps its link, profile, tax row and rule.
  if (ownedAddonIds.size && (await knex.schema.hasTable('service_addons'))) {
    const retainedIds = new Set(state.services.filter((entry) => entry && retained.has(entry.key)).map((entry) => entry.id));
    for (const link of state.addons) {
      if (!link || !link.id || retainedIds.has(link.parent) || retainedIds.has(link.addon)) continue;
      await knex('service_addons').where({ id: link.id }).del();
    }
  }
  await removeMarked(knex, 'service_completion_profiles', state.profiles, 'profile', retained);
  await removeMarked(knex, 'service_taxability', state.taxability, 'taxability row', retained);
  await removeMarked(knex, 'service_discount_rules', state.rules, 'discount rule', retained);
  if (removableIds.length && (await knex.schema.hasTable('services'))) {
    await knex('services').whereIn('id', removableIds).del();
  }
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
