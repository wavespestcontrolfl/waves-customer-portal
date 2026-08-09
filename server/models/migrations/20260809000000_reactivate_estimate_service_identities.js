/**
 * Reactivate/complete the four estimate options that sold deactivated
 * services (owner ruling 2026-08-09: "turn them back on").
 *
 * The 2026-08-08 audit found four published estimate options mapping only
 * to INACTIVE catalog rows. History shows the faithful fix differs per
 * option — two of the archived rows were retired by LATER owner rulings
 * this migration must not reverse:
 *
 *  - palm_injection: TRUE REACTIVATION. The 2026-05-19 cleanup archived
 *    the row as "legacy" while noting the pricing engine still fully
 *    prices it — and it is a published estimate option today. Flags flip
 *    back (active, not archived, customer_visible; booking stays off —
 *    injection work is assessment-first) and short_name is set to
 *    'Palm Injection', the exact label slot-reservation and the engine
 *    emit, so the completion resolver's short_name pass links visits.
 *    Its typed profile (project_type palm_injection) survived the
 *    archive and is already active — untouched.
 *  - german_roach / german_roach_initial: NEW ROWS. The archived
 *    pest_initial_german_knockdown row was retired by the 2026-07-30
 *    owner ruling (cockroach_control IS the roach booking service) and
 *    its key/name never matched these options' engine identity anyway
 *    (priceGermanRoach emits 'german_roach', priceGermanRoachInitial
 *    emits 'german_roach_initial' / 'German Roach Initial (3-Visit)').
 *    The archive stays; the options get their own rows.
 *  - lawn_pest_knockdown: NEW ROW. The archived lawn_insect_control row
 *    (2026-05-19 cleanup) never matched this option's label; the option
 *    is the canonical standalone turf-pest treatment priced via
 *    priceOneTimeLawn's pest multiplier. Typed one_time_lawn_treatment
 *    completion IS truthful here — it is a pesticide application.
 *  - trap_only_retainer: THREE NEW ROWS, one per plan. rodent_monitoring
 *    is the legacy QUARTERLY BAIT key (repointed + deactivated by the
 *    2026-07-12 rodent graduation) — a different product; it stays
 *    retired. The plans differ in VISIT cadence (standard 4/yr, plus
 *    6/yr, monthly 12/yr) while ALL bill monthly, so a single row
 *    carrying frequency 'monthly' would make admin scheduling seed 12
 *    visits for a Standard customer who bought 4 (codex r4 P1). Per-plan
 *    rows also give each engine line label an exact catalog name, so
 *    they resolve by name with no id stamping. Trap checks complete on
 *    the typed rodent_trapping form (traps and captures — NOT the
 *    bait-station schema, whose required stations/consumption fields a
 *    trap visit cannot truthfully fill).
 *
 * Durations follow the flat-60 owner directive (20260703120000). Tax and
 * license mirror each family's live prod siblings (row-level taxability
 * is under separate owner review — "commercial work is taxable" — which
 * lands as its own coordinated change; these values keep family parity
 * until then).
 *
 * Same hardened ownership/rollback contract as 20260808080000: inserted
 * UUIDs + palm's prior flags recorded in a system_settings state row;
 * down() restores palm's exact prior flags and removes ONLY unreferenced
 * inserted rows (service_id refs, CASCADE config, discount wiring, and
 * every resolver name alias all force retain+deactivate with the profile
 * left active); healed profiles on pre-existing rows are removed;
 * admin-recreated rows keep their inherited profile.
 */

const SERVICES = [
  {
    service_key: 'german_roach',
    // Verbatim public-ranges label; the estimate line is severity-priced.
    name: 'German Roach Cleanout',
    short_name: 'German Roach',
    description: 'Severity-based German cockroach cleanout — all-in flat price by infestation level, including the return trips needed to break the breeding cycle.',
    category: 'pest_control',
    billing_type: 'one_time',
    default_duration_minutes: 60, // flat 60 per 20260703120000
    min_duration_minutes: 60,
    max_duration_minutes: 180,
    pricing_type: 'variable',
    base_price: 350.0, // priceGermanRoach light tier
    price_range_min: 350.0, // severity tiers 350/450/550
    price_range_max: 550.0,
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    // NO requires_follow_up (codex r2 P1, superseding the r1 request for
    // alert/14d): the follow-up CTA chain is only bounded for
    // TWO_TREATMENT_PACKAGE_KEYS, so an alert policy on a 2-4 visit
    // program mints an unbounded series of $0 visits — each included
    // child completing raises another alert. These programs are SOLD as
    // a package and their visits are booked together; automatic
    // follow-up needs program-position tracking that does not exist yet
    // (queued with the link-at-write lane).
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪳',
    color: '#0ea5e9',
    sort_order: 12,
    default_products: JSON.stringify(['Advion Gel', 'Gentrol IGR']),
    internal_notes: 'Severity tiers light/moderate/heavy = $350/$450/$550 via priceGermanRoach. Distinct from the retired pest_initial_german_knockdown row (archived by the 2026-07-30 roach ruling — leave archived).',
  },
  {
    service_key: 'german_roach_initial',
    // Verbatim engine line name (priceGermanRoachInitial).
    name: 'German Roach Initial (3-Visit)',
    short_name: 'GR Initial',
    description: 'Three-visit German roach initial program for customers starting recurring service — knockdown plus two follow-up visits to break the breeding cycle.',
    category: 'pest_control',
    billing_type: 'one_time',
    default_duration_minutes: 60, // flat 60 per 20260703120000
    min_duration_minutes: 60,
    max_duration_minutes: 120,
    pricing_type: 'variable',
    base_price: 100.0, // priceGermanRoachInitial per-visit (3 visits)
    price_range_min: null, // per-visit pricing varies by recurring status — no honest per-job range
    price_range_max: null,
    is_waveguard: false,
    is_taxable: false,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    // NO requires_follow_up (codex r2 P1, superseding the r1 request for
    // alert/14d): the follow-up CTA chain is only bounded for
    // TWO_TREATMENT_PACKAGE_KEYS, so an alert policy on a 2-4 visit
    // program mints an unbounded series of $0 visits — each included
    // child completing raises another alert. These programs are SOLD as
    // a package and their visits are booked together; automatic
    // follow-up needs program-position tracking that does not exist yet
    // (queued with the link-at-write lane).
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪳',
    color: '#0ea5e9',
    sort_order: 13,
    default_products: JSON.stringify(['Advion Gel', 'Gentrol IGR']),
    internal_notes: 'Per-visit price via priceGermanRoachInitial (3 visits); recurring-customer discount applies. Range fields NULL — per-visit basis has no honest per-job envelope.',
  },
  {
    service_key: 'lawn_pest_knockdown',
    // Verbatim public-ranges label. The pricer is priceOneTimeLawn with
    // the pest multiplier (emits the shared 'one_time_lawn' key), so the
    // published option key is this line's only stable identity.
    name: 'Lawn Pest Knockdown',
    short_name: 'Lawn Knockdown',
    description: 'Standalone one-time turf-pest treatment — chinch bugs, sod webworms, armyworms, grubs. Can be combined with a weed treatment.',
    category: 'lawn_care',
    billing_type: 'one_time',
    default_duration_minutes: 60, // flat 60 per 20260703120000
    min_duration_minutes: 60,
    max_duration_minutes: 180,
    pricing_type: 'variable',
    base_price: 150.0, // priceOneTimeLawn 5k track B standard, pest
    price_range_min: 127.0, // published range low
    price_range_max: 632.0, // published range high
    pricing_model_key: 'sqft_lawn',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'lawn_care',
    requires_license: true,
    license_category: 'L&O',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🌿',
    color: '#16a34a',
    sort_order: 63,
    internal_notes: 'Pesticide application (L&O). Priced via priceOneTimeLawn treatmentType=pest. Distinct from the archived lawn_insect_control row (2026-05-19 cleanup — leave archived).',
  },
  // ONE ROW PER PLAN (codex r4 P1): the plans differ in VISIT cadence
  // (4 / 6 / 12 per year), and monthly BILLING is not a visit frequency —
  // a single 'monthly' row would make admin scheduling seed 12 visits for
  // a Standard customer who bought 4. Per-plan rows also give each engine
  // line label ('Standard Trap-Only Retainer', …) an exact catalog name,
  // so name-resolution links them without any id stamping.
  ...[
    { plan: 'standard', label: 'Standard Trap-Only Retainer', short: 'Trap Std', monthly: 49.0, annual: 495.0, visits: 4, frequency: 'quarterly', callbacks: 2, sort: 48 },
    { plan: 'plus', label: 'Plus Trap-Only Retainer', short: 'Trap Plus', monthly: 69.0, annual: 695.0, visits: 6, frequency: 'bimonthly', callbacks: 3, sort: 49 },
    { plan: 'monthly', label: 'Monthly Trap-Only Retainer', short: 'Trap Monthly', monthly: 99.0, annual: 995.0, visits: 12, frequency: 'monthly', callbacks: 2, sort: 50 },
  ].map((tier) => ({
    service_key: `trap_only_retainer_${tier.plan}`,
    // Verbatim priceTrapOnlyRetainer line name for this plan.
    name: tier.label,
    short_name: tier.short,
    description: `Trap-monitoring retainer with ${tier.visits} scheduled visits per year and ${tier.callbacks} included response callbacks. No structural warranty without exclusion.`,
    category: 'rodent',
    billing_type: 'recurring',
    // VISIT cadence, never the billing cadence.
    frequency: tier.frequency,
    visits_per_year: tier.visits,
    default_duration_minutes: 60, // flat 60 per 20260703120000
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    // Prices stay NULL, matching EVERY live recurring catalog row
    // (verified in prod 2026-08-09): admin scheduling copies base_price
    // onto the VISIT, and a monthly due is not a per-visit price —
    // stamping $49 on each of 4 visits would bill $196/yr instead of
    // $588/yr and skip the setup fee (codex r2 P1). Retainer billing is
    // the pricer's authority; the catalog row carries identity only.
    pricing_type: 'variable',
    base_price: null,
    price_range_min: null,
    price_range_max: null,
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '\u{1F400}',
    color: '#78716c',
    sort_order: tier.sort,
    internal_notes: `Trap-only retainer, ${tier.plan} plan: $${tier.monthly}/mo or $${tier.annual}/yr prepaid (setup fee applies to monthly billing; callbacks beyond ${tier.callbacks} bill the extra-callback rate). ${tier.visits} scheduled visits/year — billing cadence is monthly for all plans and is NOT the visit frequency. Distinct from the retired legacy rodent_monitoring quarterly bait key.`,
  })),
];

// key → completion profile pointer. The two roach programs are generic by
// design (the retired typed pest form stays retired — registry
// ONE_TIME_GENERIC_BY_DESIGN entries land with this migration); the lawn
// knockdown IS a pesticide lawn application (typed form truthful); trap
// checks ride the typed bait-station form (the rodent_monitoring repoint
// decision, #2673).
const PROFILE_TYPES = {
  german_roach: null,
  german_roach_initial: null,
  lawn_pest_knockdown: 'one_time_lawn_treatment',
  // Trap checks record traps and captures — the rodent_trapping form.
  // NOT rodent_bait_station (an exterior bait-station schema requiring
  // stations_checked/bait_consumption a trap-only visit cannot truthfully
  // fill; codex r2 P1).
  trap_only_retainer_standard: 'rodent_trapping',
  trap_only_retainer_plus: 'rodent_trapping',
  trap_only_retainer_monthly: 'rodent_trapping',
};

const PALM_KEY = 'palm_injection';
const PALM_TARGET_FLAGS = {
  is_active: true,
  is_archived: false,
  customer_visible: true,
  short_name: 'Palm Injection',
};

const STATE_KEY = 'migration.20260809000000.state';
const PROFILE_MARKER = '[reactivate_estimate_identities=inserted]';

async function recordState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const existing = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (existing) {
    let prior = { services: [], profiles: [], palm: null };
    try { prior = { services: [], profiles: [], palm: null, ...JSON.parse(existing.value) }; } catch { /* keep empty */ }
    const byId = new Map();
    for (const entry of [...prior.services, ...state.services]) {
      if (entry && entry.id) byId.set(entry.id, entry);
    }
    const merged = {
      services: [...byId.values()],
      profiles: [...new Set([...prior.profiles, ...state.profiles])],
      // First run's record wins — it holds the true pre-migration flags.
      palm: prior.palm || state.palm,
    };
    await knex('system_settings').where({ key: STATE_KEY }).update({ value: JSON.stringify(merged) });
  } else {
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) {
    console.warn('[reactivate-identities] services table absent — skipping');
    return;
  }

  const inserted = { services: [], profiles: [], palm: null };

  // 1. Palm reactivation — record the exact prior values of ONLY the
  // fields changed, so down() restores them verbatim.
  const palm = await knex('services').where({ service_key: PALM_KEY }).first();
  if (!palm) {
    console.warn('[reactivate-identities] palm_injection row absent — nothing to reactivate');
  } else {
    const changed = {};
    const prior = {};
    for (const [field, target] of Object.entries(PALM_TARGET_FLAGS)) {
      if (palm[field] !== target) {
        changed[field] = target;
        prior[field] = palm[field] === undefined ? null : palm[field];
      }
    }
    if (Object.keys(changed).length === 0) {
      console.log('[reactivate-identities] palm_injection already at target flags — no-op');
    } else {
      await knex('services').where({ id: palm.id }).update(changed);
      inserted.palm = { id: palm.id, prior };
      console.log(`[reactivate-identities] palm_injection reactivated (${Object.keys(changed).join(', ')})`);
    }
  }

  // 2. New rows — identical contract to 20260808080000.
  for (const svc of SERVICES) {
    const exists = await knex('services').where({ service_key: svc.service_key }).first();
    if (exists) {
      console.warn(`[reactivate-identities] ${svc.service_key}: services row already exists — leaving untouched`);
      continue;
    }
    const returned = await knex('services').insert(svc).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: svc.service_key, id: newId });
      console.log(`[reactivate-identities] ${svc.service_key}: services row inserted (${newId})`);
    } else {
      console.warn(`[reactivate-identities] ${svc.service_key}: inserted but no id returned — row will survive rollback`);
    }
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[reactivate-identities] service_completion_profiles table absent — skipping profiles');
    await recordState(knex, inserted);
    return;
  }

  for (const svc of SERVICES) {
    const service = await knex('services').where({ service_key: svc.service_key }).first();
    if (!service) {
      console.warn(`[reactivate-identities] ${svc.service_key}: services row absent after insert pass — skipping profile`);
      continue;
    }
    if (service.is_active !== true || service.is_archived === true) {
      console.warn(`[reactivate-identities] ${svc.service_key}: services row is not explicitly active (or archived) — skipping profile (admin decision preserved)`);
      continue;
    }
    const existing = await knex('service_completion_profiles')
      .where({ service_key: svc.service_key })
      .first();
    if (existing) {
      console.warn(`[reactivate-identities] ${svc.service_key}: completion profile already exists — leaving untouched`);
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
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: followupPolicy,
      default_followup_days: followupDays,
      active: true,
      notes: PROFILE_MARKER,
    });
    inserted.profiles.push(svc.service_key);
    console.log(`[reactivate-identities] ${svc.service_key}: profile inserted → service_report/${PROFILE_TYPES[svc.service_key] || 'generic'}/auto_send`);
  }

  await recordState(knex, inserted);
};

exports.down = async function down(knex) {
  let state = { services: [], profiles: [], palm: null };
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (row) {
      try {
        state = { services: [], profiles: [], palm: null, ...JSON.parse(row.value) };
      } catch (e) {
        console.warn(`[reactivate-identities] down: unreadable state row (${e.message}) — removing nothing`);
      }
    }
  }

  // Palm: restore a field ONLY if it still holds the value up() wrote —
  // an admin who changed the posture after deploy owns that field now
  // (codex r4 P2), the same admin-edit rule the row/profile paths use.
  if (state.palm && state.palm.id && (await knex.schema.hasTable('services'))) {
    const current = await knex('services').where({ id: state.palm.id }).first();
    if (!current) {
      console.warn('[reactivate-identities] down: palm_injection row is gone — nothing to restore');
    } else {
      const restore = {};
      const skipped = [];
      for (const [field, priorValue] of Object.entries(state.palm.prior)) {
        // PALM_TARGET_FLAGS[field] is exactly what up() wrote.
        if (current[field] === PALM_TARGET_FLAGS[field]) restore[field] = priorValue;
        else skipped.push(field);
      }
      if (Object.keys(restore).length > 0) {
        await knex('services').where({ id: state.palm.id }).update(restore);
      }
      console.log(`[reactivate-identities] down: palm_injection restored [${Object.keys(restore).join(', ') || 'none'}]${skipped.length ? `; admin-edited since deploy, left alone: [${skipped.join(', ')}]` : ''}`);
    }
  }

  // New rows: identical retention doctrine to 20260808080000 — delete
  // only when NOTHING references the row.
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
    if (await knex.schema.hasTable('service_discount_rules')) {
      refs += (await knex('service_discount_rules').where({ service_key: entry.key }).pluck('service_key')).length;
    }
    if (await knex.schema.hasTable('discounts')) {
      refs += (await knex('discounts').where({ service_key_filter: entry.key }).pluck('service_key_filter')).length;
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
    const row = await knex('services').where({ id: entry.id }).first();
    if (row) {
      const aliases = [...new Set([
        row.name,
        row.name ? `${row.name} Service` : null,
        row.short_name,
      ].filter(Boolean))];
      for (const alias of aliases) {
        if (await knex.schema.hasTable('scheduled_services')) {
          refs += (await knex('scheduled_services').whereRaw('lower(service_type) = lower(?)', [alias]).pluck('id')).length;
        }
        if (await knex.schema.hasTable('scheduled_service_addons')) {
          refs += (await knex('scheduled_service_addons').whereRaw('lower(service_name) = lower(?)', [alias]).pluck('id')).length;
        }
      }
      // The resolver also strips a "— N Visit Program" tail (the roach
      // cleanout's severity-tiered label), so a visit persisted WITH that
      // suffix resolves this row and must block deletion too — the sweep
      // mirrors every alias serviceNameCandidates accepts.
      if (row.name) {
        const programPattern = `${row.name}%visit program`;
        if (await knex.schema.hasTable('scheduled_services')) {
          refs += (await knex('scheduled_services').whereRaw('lower(service_type) LIKE lower(?)', [programPattern]).pluck('id')).length;
        }
        if (await knex.schema.hasTable('scheduled_service_addons')) {
          refs += (await knex('scheduled_service_addons').whereRaw('lower(service_name) LIKE lower(?)', [programPattern]).pluck('id')).length;
        }
      }
    }
    if (refs > 0) {
      retainedKeys.add(entry.key);
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[reactivate-identities] down: ${entry.key} (${entry.id}) has ${refs} reference(s) — service retained+deactivated, profile left active (links keep resolving)`);
    } else {
      removable.push(entry);
    }
  }
  const removableIds = removable.map((entry) => entry.id);

  if (state.profiles.length > 0 && (await knex.schema.hasTable('service_completion_profiles'))) {
    for (const key of state.profiles) {
      if (retainedKeys.has(key)) continue;
      const currentService = await knex('services').where({ service_key: key }).first();
      const weInsertedTheService = state.services.some((entry) => entry && entry.key === key);
      if (currentService && !removableIds.includes(currentService.id) && weInsertedTheService) {
        console.warn(`[reactivate-identities] down: profile ${key} serves an admin-recreated service row (${currentService.id}) — leaving untouched`);
        continue;
      }
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile) continue;
      if (!String(profile.notes || '').includes(PROFILE_MARKER)) {
        console.warn(`[reactivate-identities] down: profile ${key} lacks the insertion marker — admin-replaced, leaving untouched`);
        continue;
      }
      await knex('service_completion_profiles').where({ service_key: key }).del();
    }
  }

  if (removableIds.length > 0 && (await knex.schema.hasTable('services'))) {
    await knex('services').whereIn('id', removableIds).del();
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
