/**
 * Foam termite services: catalog rows + typed completion profiles.
 *
 * The pricing engine has published foam estimate ranges since June
 * (public-ranges.js), but neither foam key has ever had a services row —
 * foam is quotable on an estimate yet has nothing to schedule against,
 * so a booked foam job can only be created as an unlinked name-only
 * visit (and before d833ef54c it also classified as pest). Owner ruling
 * 2026-08-08: create the two rows now, keyed to the pricing ENGINE's own
 * service keys (catalog service_key ↔ engine key is 1:1).
 *
 * KEY VOCABULARY: priceRecurringFoam returns service 'foam_recurring',
 * and the estimate/scheduling stack speaks that key throughout (converter
 * display map, slot-reservation, recurring-appointment-seeder normalizer,
 * estimate-slot-availability). Only public-ranges.js publishes it under
 * the display key 'recurring_foam' — that stays a marketing-surface
 * label; the catalog row uses the key the converter actually resolves.
 *
 *   foam_drill     one-time tiered drill-and-foam (Spot → Full Perimeter,
 *                  priced by drill-point count via priceFoamDrill)
 *   foam_recurring standalone recurring spot-foam program (quarterly
 *                  default; bimonthly/monthly cadences priced via
 *                  priceRecurringFoam). Does NOT count toward WaveGuard
 *                  tier and is excluded from the bundle discount
 *                  (owner directive 2026-06-25).
 *
 * booking_enabled is FALSE on both (owner ruling 2026-08-08): foam is
 * priced off drill-point count, so it is assessment-first — never
 * self-bookable cold from the public picker.
 *
 * Price fields are the engine's own outputs on this commit:
 * priceFoamDrill 5→20 points = $182–$598 (base = 10-point Moderate $308);
 * priceRecurringFoam per-visit $146 (monthly, 5 pts) – $538 (quarterly,
 * 20 pts; base = quarterly entry $164).
 *
 * Completion profiles follow the termite typed cutover (20260713100000):
 * foam completes as service_report / termite_treatment with auto_send —
 * the same typed flow as termite_spot_treatment, whose description
 * already names foam injection as a method. Self-healing per key: the
 * services insert skips rows that already exist (admin-created), and the
 * profile insert never clobbers an existing profile row.
 */

const SERVICES = [
  {
    service_key: 'foam_drill',
    // EXACTLY the engine line label (priceFoamDrill returns name
    // 'Drill-and-Foam Termite'): one-time bookings schedule under the raw
    // line name, and completion's name-fallback is an exact lower(name)
    // match — an invented prettier name would never resolve (codex r4 P1).
    name: 'Drill-and-Foam Termite',
    short_name: 'Foam Drill',
    description: 'Tiered drill-and-foam termite treatment. Drill points through slab or block, foam termiticide injected into galleries and voids. Tiers: Spot (≤5 points), Moderate (≤10), Extensive (≤15), Full Perimeter (≤20).',
    category: 'termite',
    billing_type: 'one_time',
    default_duration_minutes: 90,
    min_duration_minutes: 60,
    max_duration_minutes: 180,
    pricing_type: 'variable',
    base_price: 308.0,
    price_range_min: 182.0,
    price_range_max: 598.0,
    pricing_model_key: 'drill_points',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪵',
    color: '#dc2626',
    sort_order: 39,
    default_products: JSON.stringify(['Termidor Foam']),
    internal_notes: 'Priced by drill-point count via priceFoamDrill — assessment determines points before scheduling; not self-bookable.',
  },
  {
    service_key: 'foam_recurring',
    // EXACTLY the reserved-slot label (slot-reservation returns 'Recurring
    // Foam Treatment' for foam_recurring) and the engine's cadence-less
    // base name — reserved rows carry no service_id, so the exact-name
    // fallback is their only route to the typed profile (codex r4 P1).
    // Cadence-suffixed converter rows link by service_id instead.
    name: 'Recurring Foam Treatment',
    short_name: 'Recurring Foam',
    description: 'Recurring spot-foam termite program at a per-application discount vs one-time treatment. Quarterly, bi-monthly, or monthly cadence; up to 20 drill points per application (larger jobs are one-time foam or custom).',
    category: 'termite',
    billing_type: 'recurring',
    frequency: 'quarterly',
    visits_per_year: 4,
    // NO default: priceRecurringFoam emits a tier-accurate slot duration
    // (60–180 min by drill points), and the converter's catalog lookup
    // OVERWRITES svc.estimatedDurationMinutes with any non-null default —
    // a default here would clobber a correct 180-min Full Perimeter slot.
    default_duration_minutes: null,
    min_duration_minutes: 60,
    max_duration_minutes: 180,
    pricing_type: 'variable',
    base_price: 164.0,
    price_range_min: 146.0,
    price_range_max: 538.0,
    pricing_model_key: 'drill_points',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    icon: '🪵',
    color: '#dc2626',
    sort_order: 39,
    default_products: JSON.stringify(['Termidor Foam']),
    internal_notes: 'STANDALONE program: excluded from WaveGuard tier count and bundle discount (owner directive 2026-06-25). Quarterly is the default cadence; bimonthly/monthly ride scheduled_services.recurring_pattern. Assessment-first; not self-bookable.',
  },
];

const STATE_KEY = 'migration.20260808070000.state';
const PROFILE_MARKER = '[foam_catalog_action=inserted]';

// state.services entries are { key, id } — down() removes services by the
// recorded UUID, never by key, so a row an admin deleted and recreated
// under the same key (new UUID) survives rollback (codex r4 P1).
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
    console.warn('[foam-catalog] services table absent — skipping');
    return;
  }

  const inserted = { services: [], profiles: [] };

  for (const svc of SERVICES) {
    const exists = await knex('services').where({ service_key: svc.service_key }).first();
    if (exists) {
      console.warn(`[foam-catalog] ${svc.service_key}: services row already exists — leaving untouched`);
      continue;
    }
    const returned = await knex('services').insert(svc).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: svc.service_key, id: newId });
      console.log(`[foam-catalog] ${svc.service_key}: services row inserted (${newId})`);
    } else {
      // No UUID back means down() cannot prove ownership — leave the row
      // out of the removable set rather than guessing by key.
      console.warn(`[foam-catalog] ${svc.service_key}: inserted but no id returned — row will survive rollback`);
    }
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[foam-catalog] service_completion_profiles table absent — skipping profiles');
    await recordState(knex, inserted);
    return;
  }

  for (const svc of SERVICES) {
    const service = await knex('services').where({ service_key: svc.service_key }).first();
    if (!service) {
      console.warn(`[foam-catalog] ${svc.service_key}: services row absent after insert pass — skipping profile`);
      continue;
    }
    // An admin-deactivated/archived row keeps its posture: attaching an
    // active auto_send profile would re-enable typed sends the admin
    // turned off (codex 2026-08-08 P1 — same rule as the termite cutover's
    // inactive-row loud skip). Explicitly-true only: NULL is_active reads
    // as inactive in every catalog filter, and completion-profile
    // resolution never re-checks the service's active state (codex r5 P2).
    // Rows this migration just inserted always carry is_active: true.
    if (service.is_active !== true || service.is_archived === true) {
      console.warn(`[foam-catalog] ${svc.service_key}: services row is not explicitly active (or archived) — skipping profile (admin decision preserved)`);
      continue;
    }
    const existing = await knex('service_completion_profiles')
      .where({ service_key: svc.service_key })
      .first();
    if (existing) {
      console.warn(`[foam-catalog] ${svc.service_key}: completion profile already exists — leaving untouched`);
      continue;
    }
    const followupPolicy = service.requires_follow_up ? 'alert' : 'none';
    const followupDays = service.requires_follow_up
      ? (Number(service.follow_up_interval_days) || 14)
      : null;
    await knex('service_completion_profiles').insert({
      service_key: svc.service_key,
      service_name_snapshot: service.name,
      category: 'termite',
      billing_type: service.billing_type || 'one_time',
      completion_mode: 'service_report',
      project_type: 'termite_treatment',
      delivery_mode: 'auto_send',
      creates_service_record: true,
      // Matches the LIVE prod posture of the termite_treatment siblings
      // (termite_spot_treatment / termite_liquid verified 2026-08-08),
      // not the 20260713100000 heal-path defaults.
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: followupPolicy,
      default_followup_days: followupDays,
      active: true,
      notes: PROFILE_MARKER,
    });
    inserted.profiles.push(svc.service_key);
    console.log(`[foam-catalog] ${svc.service_key}: profile inserted → service_report/termite_treatment/auto_send`);
  }

  await recordState(knex, inserted);
};

exports.down = async function down(knex) {
  // Remove ONLY what up() proved it inserted — services by recorded UUID
  // (a same-key row an admin recreated has a new UUID and survives),
  // profiles by key AND the insertion marker in notes (an admin-replaced
  // profile without the marker survives). No state row (or no
  // system_settings table) → up() never inserted anything here.
  let state = { services: [], profiles: [] };
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (row) {
      try {
        state = { services: [], profiles: [], ...JSON.parse(row.value) };
      } catch (e) {
        console.warn(`[foam-catalog] down: unreadable state row (${e.message}) — removing nothing`);
      }
    }
  }

  if (state.profiles.length > 0 && (await knex.schema.hasTable('service_completion_profiles'))) {
    for (const key of state.profiles) {
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile) continue;
      if (!String(profile.notes || '').includes(PROFILE_MARKER)) {
        console.warn(`[foam-catalog] down: profile ${key} lacks the insertion marker — admin-replaced, leaving untouched`);
        continue;
      }
      await knex('service_completion_profiles').where({ service_key: key }).del();
    }
  }

  const ids = state.services.map((entry) => entry && entry.id).filter(Boolean);
  if (ids.length > 0 && (await knex.schema.hasTable('services'))) {
    if (await knex.schema.hasColumn('service_records', 'service_id')) {
      await knex('service_records').whereIn('service_id', ids).update({ service_id: null });
    }
    if (await knex.schema.hasColumn('scheduled_services', 'service_id')) {
      await knex('scheduled_services').whereIn('service_id', ids).update({ service_id: null });
    }
    await knex('services').whereIn('id', ids).del();
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};
