/**
 * Estimate-gap catalog rows: the seven quotable services with no identity.
 *
 * The 2026-08-08 estimate↔catalog audit (owner-directed, follow-up to the
 * foam slice #3306) found seven published estimate options with NO
 * services row and ZERO scheduled visits all-time — quotable but
 * unlinkable, unbookable cleanly, and unable to close under a typed
 * report. Owner ruling 2026-08-08: catalog is the system of record;
 * implement the fixes. This migration is the batch counterpart of
 * 20260808070000 (foam) and follows every rule that PR's nine review
 * findings established:
 *
 *  - service_key = the pricing ENGINE's emitted key, never the
 *    public-ranges display key (bird boxes: engine emits
 *    'rodent_bird_box' singular; lawn plugging: engine emits 'plugging').
 *  - name = EXACTLY the label the estate schedules under. Where the
 *    pricer emits a line name, that name wins verbatim ('Lawn Plugging',
 *    'Rodent Wire Mesh Exclusion', 'Roof-entry cover / bird box' — note
 *    the engine's singular wording differs from the published range
 *    label). Where the pricer emits no name (bora_care, dethatching,
 *    top_dressing), the public-ranges/booking label is the only
 *    vocabulary that exists ('Bora-Care Wood Treatment' is also the
 *    PublicBookingPage label verbatim). Tier-suffixed engine lines
 *    ('Rodent Guarantee (standard)') rely on service_id linking, same as
 *    foam's cadence-suffixed rows.
 *  - Price fields are engine outputs on this commit (probes noted per
 *    row); no invented numbers — fields with no honest single value stay
 *    NULL with the pricing basis in internal_notes.
 *  - Tax/license mirror the LIVE prod posture of each family's siblings
 *    (rodent/termite: is_taxable false, tax pest_control, GHP; lawn
 *    one-time: is_taxable true, tax lawn_care; the three mechanical lawn
 *    add-ons carry no pesticide application → requires_license false).
 *  - booking_enabled false everywhere EXCEPT bora_care, which the public
 *    booking picker already offers today (parity, not policy — the
 *    picker-reads-catalog cutover is phase 3).
 *  - Completion profiles reuse ONLY project_type values live in prod:
 *    termite_treatment (bora), one_time_lawn_treatment (lawn add-ons),
 *    rodent_exclusion (mesh + bird boxes — they are exclusion hardware),
 *    and NULL for rodent_guarantee (generic typed report, the live
 *    bed_bug/tick posture) with the estate-wide
 *    service_report/auto_send/token_only/recurring_customer posture.
 *
 * Self-healing + reversible, same contract as 20260808070000: skips
 * pre-existing rows, heals profiles only for explicitly-active rows,
 * records inserted UUIDs in a system_settings state row; down() removes
 * services by recorded UUID only, requires the profile insertion marker,
 * and retains any service wired into add-ons/packages (service_addons ×2
 * and service_package_items are ON DELETE CASCADE in prod).
 */

const SERVICES = [
  {
    service_key: 'bora_care',
    // Verbatim public-ranges + PublicBookingPage label.
    name: 'Bora-Care Wood Treatment',
    short_name: 'Bora-Care',
    description: 'Borate treatment for exposed wood — termites, wood-boring beetles, and wood-decay fungi. Priced by treated attic and surface area.',
    category: 'termite',
    billing_type: 'one_time',
    default_duration_minutes: 90,
    min_duration_minutes: 60,
    max_duration_minutes: 240,
    pricing_type: 'variable',
    base_price: 1946.0, // priceBoraCare(2000, {attic:true})
    price_range_min: 255.0, // published range low
    price_range_max: 16760.0, // published range high
    pricing_model_key: 'sqft_structure',
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: true,
    is_active: true,
    is_archived: false,
    icon: '🪵',
    color: '#dc2626',
    sort_order: 39,
    default_products: JSON.stringify(['Bora-Care']),
    internal_notes: 'Priced via priceBoraCare by attic + surface sq ft. booking_enabled=true is parity with the live PublicBookingPage entry, not new policy.',
  },
  {
    service_key: 'dethatching',
    name: 'Lawn Dethatching',
    short_name: 'Dethatch',
    description: 'Mechanical dethatching for Bermuda and Zoysia lawns. St. Augustine and large heavy-debris jobs are quoted after inspection.',
    category: 'lawn_care',
    billing_type: 'one_time',
    default_duration_minutes: 120,
    min_duration_minutes: 60,
    max_duration_minutes: 240,
    pricing_type: 'variable',
    base_price: 150.0, // priceDethatching(2000, {grassType:'bermuda'})
    price_range_min: 127.0, // published range low
    price_range_max: 632.0, // published range high
    pricing_model_key: 'sqft_lawn',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'lawn_care',
    requires_license: false,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🌿',
    color: '#16a34a',
    sort_order: 60,
    internal_notes: 'Mechanical service, no pesticide application (no L&O license needed). Non-Bermuda/Zoysia and heavy-cleanup configs return quoteRequired from priceDethatching.',
  },
  {
    service_key: 'plugging',
    // Engine key is 'plugging' (pricePlugging), not the published
    // 'lawn_plugging'; engine line name matches the range label.
    name: 'Lawn Plugging',
    short_name: 'Plugging',
    description: 'Sod plug installation priced by plug spacing (6", 9", or 12") and treated area; small jobs carry a minimum.',
    category: 'lawn_care',
    billing_type: 'one_time',
    default_duration_minutes: 180,
    min_duration_minutes: 60,
    max_duration_minutes: 360,
    pricing_type: 'variable',
    base_price: 2443.0, // pricePlugging(1000, 12)
    price_range_min: 1222.0, // pricePlugging(500, 12) — smallest common job
    price_range_max: null, // open-ended: $2.07–$9.77/sq ft by spacing, large areas scale linearly
    pricing_model_key: 'sqft_lawn',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'lawn_care',
    requires_license: false,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🌿',
    color: '#16a34a',
    sort_order: 61,
    internal_notes: 'Per-sq-ft pricing ($2.07–$9.77 by plug spacing); price_range_max deliberately NULL — no honest per-job ceiling.',
  },
  {
    service_key: 'top_dressing',
    name: 'Lawn Top Dressing',
    short_name: 'Top Dress',
    description: 'Sand top dressing priced by measured lawn area and depth. Recurring-plan customers receive a discounted rate.',
    category: 'lawn_care',
    billing_type: 'one_time',
    default_duration_minutes: 120,
    min_duration_minutes: 60,
    max_duration_minutes: 300,
    pricing_type: 'variable',
    base_price: 250.0, // priceTopDressing(5000, 'eighth')
    price_range_min: 212.0, // published range low
    price_range_max: 8851.0, // published range high
    pricing_model_key: 'sqft_lawn',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'lawn_care',
    requires_license: false,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🌿',
    color: '#16a34a',
    sort_order: 62,
    internal_notes: 'Material + delivery + labor priced by area and depth via priceTopDressing.',
  },
  {
    service_key: 'rodent_wire_mesh',
    // Verbatim engine line name (priceRodentWireMesh).
    name: 'Rodent Wire Mesh Exclusion',
    short_name: 'Wire Mesh',
    description: 'Wire mesh exclusion priced per linear foot by substrate, with a job minimum.',
    category: 'rodent',
    billing_type: 'one_time',
    default_duration_minutes: 120,
    min_duration_minutes: 60,
    max_duration_minutes: 300,
    pricing_type: 'variable',
    base_price: 195.0, // priceRodentWireMesh({}) — job minimum
    price_range_min: 165.0, // published range low
    price_range_max: 9600.0, // published range high
    pricing_model_key: 'linear_ft',
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🐀',
    color: '#78716c',
    sort_order: 45,
    internal_notes: 'Exclusion hardware line — completes under the rodent_exclusion typed report like rodent_exclusion_only.',
  },
  {
    service_key: 'rodent_bird_box',
    // Verbatim engine line name (priceRodentBirdBoxes) — singular, NOT
    // the published range label "Roof-Entry Covers / Bird Boxes".
    name: 'Roof-entry cover / bird box',
    short_name: 'Bird Box',
    description: 'Roof-entry covers and bird boxes priced per cover: small $195, standard $225 (same-visit additional $175), large $295, oversized/custom $395.',
    category: 'rodent',
    billing_type: 'one_time',
    default_duration_minutes: 60,
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    pricing_type: 'variable',
    base_price: 225.0, // priceRodentBirdBoxes({birdBoxQuantity:1}) — standard cover
    price_range_min: 165.0, // published range low
    price_range_max: 3160.0, // published range high
    pricing_model_key: 'per_unit',
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🐀',
    color: '#78716c',
    sort_order: 46,
    internal_notes: 'Exclusion hardware line — completes under the rodent_exclusion typed report.',
  },
  {
    service_key: 'rodent_guarantee',
    // Engine lines carry a tier suffix ('Rodent Guarantee (standard)');
    // the base name matches the published label — suffixed lines link by
    // service_id, same as foam's cadence-suffixed rows.
    name: 'Rodent Guarantee',
    short_name: 'Rodent Guar.',
    description: 'Renewable 12-month rodent-free guarantee. Eligibility requires completed trapping, completed exclusion, sanitation completed (or photo baseline), and no activity after the final trap check. Priced by property tier.',
    category: 'rodent',
    billing_type: 'one_time',
    default_duration_minutes: 30,
    min_duration_minutes: 15,
    max_duration_minutes: 60,
    pricing_type: 'variable',
    base_price: 199.0, // priceRodentGuarantee standard tier
    price_range_min: 199.0, // published range low
    price_range_max: 299.0, // published range high
    pricing_model_key: 'property_tier',
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🐀',
    color: '#78716c',
    sort_order: 47,
    internal_notes: 'Guarantee program, not a treatment — generic typed report (NULL project_type, the live bed_bug/tick posture). Eligibility gates live in the rodent guarantee pricer/flow.',
  },
];

// key → completion profile project_type (NULL = generic typed report).
const PROFILE_TYPES = {
  bora_care: 'termite_treatment',
  dethatching: 'one_time_lawn_treatment',
  plugging: 'one_time_lawn_treatment',
  top_dressing: 'one_time_lawn_treatment',
  rodent_wire_mesh: 'rodent_exclusion',
  rodent_bird_box: 'rodent_exclusion',
  rodent_guarantee: null,
};

const STATE_KEY = 'migration.20260808080000.state';
const PROFILE_MARKER = '[estimate_gap_catalog_action=inserted]';

// state.services entries are { key, id } — down() removes services by the
// recorded UUID, never by key, so a row an admin deleted and recreated
// under the same key (new UUID) survives rollback.
async function recordState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (existing) {
    // Union with the prior run's record so a re-run can never shrink the
    // set of rows down() is allowed to remove.
    let prior = { services: [], profiles: [] };
    try { prior = { services: [], profiles: [], ...JSON.parse(existing.value) }; } catch { /* keep empty */ }
    const byId = new Map();
    for (const entry of [...prior.services, ...state.services]) {
      if (entry && entry.id) byId.set(entry.id, entry);
    }
    const merged = {
      services: [...byId.values()],
      profiles: [...new Set([...prior.profiles, ...state.profiles])],
    };
    await knex('system_settings').where({ key: STATE_KEY }).update({ value: JSON.stringify(merged) });
  } else {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[estimate-gap-catalog] services table absent — skipping');
    return;
  }

  const inserted = { services: [], profiles: [] };

  for (const svc of SERVICES) {
    const exists = await knex('services').where({ service_key: svc.service_key }).first();
    if (exists) {
      console.warn(`[estimate-gap-catalog] ${svc.service_key}: services row already exists — leaving untouched`);
      continue;
    }
    const returned = await knex('services').insert(svc).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: svc.service_key, id: newId });
      console.log(`[estimate-gap-catalog] ${svc.service_key}: services row inserted (${newId})`);
    } else {
      // No UUID back means down() cannot prove ownership — leave the row
      // out of the removable set rather than guessing by key.
      console.warn(`[estimate-gap-catalog] ${svc.service_key}: inserted but no id returned — row will survive rollback`);
    }
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[estimate-gap-catalog] service_completion_profiles table absent — skipping profiles');
    await recordState(knex, inserted);
    return;
  }

  for (const svc of SERVICES) {
    const service = await knex('services').where({ service_key: svc.service_key }).first();
    if (!service) {
      console.warn(`[estimate-gap-catalog] ${svc.service_key}: services row absent after insert pass — skipping profile`);
      continue;
    }
    // An admin-deactivated/archived row keeps its posture — explicitly
    // true only: NULL is_active reads as inactive in every catalog
    // filter, and profile resolution never re-checks active state. Rows
    // this migration just inserted always carry is_active: true.
    if (service.is_active !== true || service.is_archived === true) {
      console.warn(`[estimate-gap-catalog] ${svc.service_key}: services row is not explicitly active (or archived) — skipping profile (admin decision preserved)`);
      continue;
    }
    const existing = await knex('service_completion_profiles')
      .where({ service_key: svc.service_key })
      .first();
    if (existing) {
      console.warn(`[estimate-gap-catalog] ${svc.service_key}: completion profile already exists — leaving untouched`);
      continue;
    }
    const followupPolicy = service.requires_follow_up ? 'alert' : 'none';
    const followupDays = service.requires_follow_up
      ? (Number(service.follow_up_interval_days) || 14)
      : null;
    await knex('service_completion_profiles').insert({
      service_key: svc.service_key,
      service_name_snapshot: service.name,
      category: service.category,
      billing_type: service.billing_type || 'one_time',
      completion_mode: 'service_report',
      project_type: PROFILE_TYPES[svc.service_key] ?? null,
      delivery_mode: 'auto_send',
      creates_service_record: true,
      // Estate-wide live posture (every one-time sibling verified in prod
      // 2026-08-08): token_only + recurring_customer.
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: followupPolicy,
      default_followup_days: followupDays,
      active: true,
      notes: PROFILE_MARKER,
    });
    inserted.profiles.push(svc.service_key);
    console.log(`[estimate-gap-catalog] ${svc.service_key}: profile inserted → service_report/${PROFILE_TYPES[svc.service_key] || 'generic'}/auto_send`);
  }

  await recordState(knex, inserted);
};

exports.down = async function down(knex) {
  // Remove ONLY what up() proved it inserted — services by recorded UUID
  // (a same-key row an admin recreated has a new UUID and survives),
  // profiles by key AND the insertion marker in notes. No state row (or
  // no system_settings table) → up() never inserted anything here.
  let state = { services: [], profiles: [] };
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (row) {
      try {
        state = { services: [], profiles: [], ...JSON.parse(row.value) };
      } catch (e) {
        console.warn(`[estimate-gap-catalog] down: unreadable state row (${e.message}) — removing nothing`);
      }
    }
  }

  // A recorded service is DELETED only when nothing references it at all.
  // Two reference classes force retention (retain + deactivate, the
  // 20260612000031 combined-cutover pattern):
  //  - service_addons (both directions) / service_package_items: ON
  //    DELETE CASCADE in prod — deletion would destroy admin config.
  //  - scheduled_services / service_records: visits and reports linked
  //    after deployment — deletion would orphan history's catalog
  //    identity and typed-completion linkage (codex P0).
  // Retained rows are deactivated instead: the service stops being
  // offered (the rollback's intent) while every link keeps resolving.
  const retainedKeys = new Set();
  const removable = [];
  for (const entry of state.services) {
    if (!entry || !entry.id) continue;
    let refs = 0;
    if (await knex.schema.hasTable('service_addons')) {
      refs += (await knex('service_addons').where({ parent_service_id: entry.id }).pluck('parent_service_id')).length;
      refs += (await knex('service_addons').where({ addon_service_id: entry.id }).pluck('addon_service_id')).length;
    }
    if (await knex.schema.hasTable('service_package_items')) {
      refs += (await knex('service_package_items').where({ service_id: entry.id }).pluck('service_id')).length;
    }
    if (await knex.schema.hasTable('scheduled_services')) {
      refs += (await knex('scheduled_services').where({ service_id: entry.id }).pluck('service_id')).length;
    }
    if (await knex.schema.hasTable('scheduled_service_addons')) {
      refs += (await knex('scheduled_service_addons').where({ service_id: entry.id }).pluck('service_id')).length;
    }
    if (await knex.schema.hasTable('service_records')) {
      refs += (await knex('service_records').where({ service_id: entry.id }).pluck('service_id')).length;
    }
    if (refs > 0) {
      // The SERVICE row deactivates (stops being offered — the rollback's
      // intent); its PROFILE stays active untouched: the visits that
      // forced retention still complete through it, and profile
      // resolution filters on active=true (deactivating it would demote
      // exactly those pending visits to the generic report).
      retainedKeys.add(entry.key);
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[estimate-gap-catalog] down: ${entry.key} (${entry.id}) has ${refs} reference(s) — service retained+deactivated, profile left active (links keep resolving)`);
    } else {
      removable.push(entry);
    }
  }
  const removableIds = removable.map((entry) => entry.id);

  if (state.profiles.length > 0 && (await knex.schema.hasTable('service_completion_profiles'))) {
    for (const key of state.profiles) {
      if (retainedKeys.has(key)) continue;
      // A same-key services row that is NOT being removed (admin deleted
      // ours and recreated it — different UUID) still relies on this
      // profile: the marker alone is not proof the profile is orphaned
      // (codex P1). Only delete when the surviving row IS ours-to-remove
      // or no row exists.
      const currentService = await knex('services').where({ service_key: key }).first();
      if (currentService && !removableIds.includes(currentService.id)) {
        console.warn(`[estimate-gap-catalog] down: profile ${key} serves a surviving service row (${currentService.id}) — leaving untouched`);
        continue;
      }
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile) continue;
      if (!String(profile.notes || '').includes(PROFILE_MARKER)) {
        console.warn(`[estimate-gap-catalog] down: profile ${key} lacks the insertion marker — admin-replaced, leaving untouched`);
        continue;
      }
      await knex('service_completion_profiles').where({ service_key: key }).del();
    }
  }

  if (removableIds.length > 0 && (await knex.schema.hasTable('services'))) {
    // Zero references proven above — nothing to null, nothing cascades.
    await knex('services').whereIn('id', removableIds).del();
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
