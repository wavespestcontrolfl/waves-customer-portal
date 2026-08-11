/**
 * Semiannual Palm Injection: recurring catalog row + typed completion profile.
 *
 * Owner ruling 2026-08-11 ("2 visits a year, and a one time for palm
 * injection"): palm injection sells as a semiannual recurring program
 * (2 visits/year) or as a one-time. The one-time already exists and is
 * active (`palm_injection`, typed profile → project_type palm_injection),
 * but the ONLY recurring palm row (`palm_treatment`, the nutritional-fert
 * service) is inactive + archived — the recurring program the owner sells
 * has nothing to schedule against. Ships alongside the converter allowlist
 * change (same PR) that seeds the semiannual series on acceptance.
 *
 * KEY VOCABULARY: `palm_injection_semiannual` follows the
 * family_cadence convention (pest_general_semiannual precedent —
 * frequency 'semiannual', visits_per_year 2). The seeder's serviceKeyFor
 * resolves any /palm/ name to the palm_injection family, so the converter
 * allowlist and the recurring-appointment seeder both land this row from
 * its name or key. `palm_treatment` stays archived — it is a different
 * service, not resurrected here.
 *
 * booking_enabled FALSE (mirrors the one-time palm row): palm work is
 * priced per palm from the assessment/estimator (PALM_TREATMENTS protocol
 * pricing) — assessment-first, never self-bookable cold. is_waveguard
 * FALSE: palm is NOT a tier qualifier; it carries only the Gold+ $10/palm
 * flat credit (pricing-engine constants, owner ruling 2026-08-08).
 *
 * Field posture is the ACTIVE one-time palm_injection row's (durations,
 * tax, license, icon, visibility — verified against prod 2026-08-11), not
 * the archived palm_treatment's. The completion profile routes through
 * the SAME typed palm form as the one-time (project_type palm_injection)
 * with the recurring portal posture of tree_shrub_program
 * (customer_portal / active_portal_customer — a recurring palm customer
 * is an active portal customer, unlike the token_only one-time lane).
 *
 * Self-healing mechanics mirror 20260808070000 (foam): insert skips an
 * existing row and the profile never clobbers or attaches to a row an
 * admin deactivated. Rollback follows the 20260809000000 retention
 * doctrine: down() removes only UUID-recorded rows it proved it inserted,
 * and ONLY when nothing references them — scheduled visits and completed
 * service records count, so a rollback after any palm series exists
 * retains the row and profile wholesale (live identity preserved).
 */

const SERVICE = {
  service_key: 'palm_injection_semiannual',
  name: 'Semiannual Palm Injection Service',
  short_name: 'Semiannual Palm',
  description: 'Recurring palm injection program — 2 visits per year. Trunk injection of micronutrients (Mn, Mg, K) and/or preventive insecticide per the palm protocol; priced per palm from the assessment.',
  category: 'tree_shrub',
  billing_type: 'recurring',
  frequency: 'semiannual',
  visits_per_year: 2,
  default_duration_minutes: 60,
  min_duration_minutes: 30,
  max_duration_minutes: 90,
  pricing_type: 'variable',
  base_price: null,
  pricing_model_key: null,
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
  icon: '🌴',
  color: '#18181B',
  sort_order: 54,
  internal_notes: 'STANDALONE semiannual program (owner ruling 2026-08-11): excluded from WaveGuard tier count (Gold+ $10/palm flat credit only). Per-palm protocol pricing via the estimator; assessment-first, not self-bookable.',
};

const STATE_KEY = 'migration.20260811000010.state';
const PROFILE_MARKER = '[palm_semiannual_catalog_action=inserted]';

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
    console.warn('[palm-semiannual] services table absent — skipping');
    return;
  }

  const inserted = { services: [], profiles: [] };

  // Roll-forward after a rollback that RETAINED the row (exemplar
  // 20260809000000): down() deactivates a referenced row and records it
  // under `retained` — reactivate exactly that row and resume tracking it
  // in the removable set. Without this, up() would see the key exists,
  // skip, and leave the program dark.
  if (await knex.schema.hasTable('system_settings')) {
    let priorRetained = [];
    const priorRow = await knex('system_settings').where({ key: STATE_KEY }).first();
    if (priorRow) {
      try { ({ retained: priorRetained = [] } = JSON.parse(priorRow.value)); } catch { priorRetained = []; }
    }
    for (const entry of priorRetained) {
      if (!entry || !entry.id) continue;
      const row = await knex('services').where({ id: entry.id }).first();
      if (!row) {
        console.warn(`[palm-semiannual] roll-forward: previously retained row ${entry.key} (${entry.id}) is gone — skipping`);
        continue;
      }
      if (row.is_active === true) {
        console.log(`[palm-semiannual] roll-forward: previously retained row ${entry.key} already active — no-op`);
      } else {
        await knex('services').where({ id: entry.id }).update({ is_active: true });
        console.log(`[palm-semiannual] roll-forward: reactivated previously retained row ${entry.key} (${entry.id})`);
      }
      inserted.services.push({ key: entry.key, id: entry.id });
    }
  }

  const exists = await knex('services').where({ service_key: SERVICE.service_key }).first();
  if (exists) {
    console.warn(`[palm-semiannual] ${SERVICE.service_key}: services row already exists — leaving untouched`);
  } else {
    const returned = await knex('services').insert(SERVICE).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: SERVICE.service_key, id: newId });
      console.log(`[palm-semiannual] ${SERVICE.service_key}: services row inserted (${newId})`);
    } else {
      // No UUID back means down() cannot prove ownership — leave the row
      // out of the removable set rather than guessing by key.
      console.warn(`[palm-semiannual] ${SERVICE.service_key}: inserted but no id returned — row will survive rollback`);
    }
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[palm-semiannual] service_completion_profiles table absent — skipping profile');
    await recordState(knex, inserted);
    return;
  }

  const service = await knex('services').where({ service_key: SERVICE.service_key }).first();
  if (!service) {
    console.warn(`[palm-semiannual] ${SERVICE.service_key}: services row absent after insert pass — skipping profile`);
    await recordState(knex, inserted);
    return;
  }
  // An admin-deactivated/archived row keeps its posture: attaching an
  // active auto_send profile would re-enable typed sends the admin turned
  // off. Explicitly-true only — NULL is_active reads as inactive in every
  // catalog filter, and completion-profile resolution never re-checks the
  // service's active state. Rows this migration just inserted always carry
  // is_active: true.
  if (service.is_active !== true || service.is_archived === true) {
    console.warn(`[palm-semiannual] ${SERVICE.service_key}: services row is not explicitly active (or archived) — skipping profile (admin decision preserved)`);
    await recordState(knex, inserted);
    return;
  }
  const existingProfile = await knex('service_completion_profiles')
    .where({ service_key: SERVICE.service_key })
    .first();
  if (existingProfile) {
    console.warn(`[palm-semiannual] ${SERVICE.service_key}: completion profile already exists — leaving untouched`);
    await recordState(knex, inserted);
    return;
  }
  await knex('service_completion_profiles').insert({
    service_key: SERVICE.service_key,
    service_name_snapshot: service.name,
    category: 'tree_shrub',
    billing_type: service.billing_type || 'recurring',
    completion_mode: 'service_report',
    project_type: 'palm_injection',
    delivery_mode: 'auto_send',
    creates_service_record: true,
    // Recurring portal posture (tree_shrub_program precedent, verified
    // against prod 2026-08-11) — NOT the one-time palm lane's token_only.
    portal_visibility: 'customer_portal',
    portal_attach_policy: 'active_portal_customer',
    followup_policy: 'none',
    default_followup_days: null,
    active: true,
    notes: PROFILE_MARKER,
  });
  inserted.profiles.push(SERVICE.service_key);
  console.log(`[palm-semiannual] ${SERVICE.service_key}: profile inserted → service_report/palm_injection/auto_send`);

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
        console.warn(`[palm-semiannual] down: unreadable state row (${e.message}) — removing nothing`);
      }
    }
  }

  // Retention doctrine (20260809000000 exemplar): delete only when NOTHING
  // references the row. Scheduled visits and completed service records
  // COUNT as references — a rollback after any palm series was accepted or
  // completed must retain the row and its typed profile wholesale, or
  // durable identity is lost and live recurring visits fall through name
  // resolution to the one-time palm profile (wrong completion/portal
  // posture). Add-on/package wiring is likewise retained.
  const retainedKeys = new Set();
  const removableIds = [];
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
    if (await knex.schema.hasTable('service_discount_rules')) {
      refs += (await knex('service_discount_rules').where({ service_key: entry.key }).pluck('service_key')).length;
    }
    if (await knex.schema.hasTable('discounts')) {
      refs += (await knex('discounts').where({ service_key_filter: entry.key }).pluck('service_key_filter')).length;
    }
    // Name-only references count too (exemplar's alias sweep): a visit
    // scheduled under the row's name/short name without a service_id still
    // resolves this row by name, so deleting it would reroute that visit's
    // completion. Aliases mirror what the completion resolver accepts.
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
    }
    if (refs > 0) {
      retainedKeys.add(entry.key);
      // Retain-AND-DEACTIVATE (exemplar 20260809000000): the rollback must
      // actually disable the program for new sales while existing links
      // keep resolving — the profile stays active for exactly that reason.
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[palm-semiannual] down: ${entry.key} (${entry.id}) has ${refs} visit/record/add-on/package/discount reference(s) — service retained+deactivated, profile left active (links keep resolving)`);
    } else {
      removableIds.push(entry.id);
    }
  }

  if (state.profiles.length > 0 && (await knex.schema.hasTable('service_completion_profiles'))) {
    for (const key of state.profiles) {
      if (retainedKeys.has(key)) continue;
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile) continue;
      if (!String(profile.notes || '').includes(PROFILE_MARKER)) {
        console.warn(`[palm-semiannual] down: profile ${key} lacks the insertion marker — admin-replaced, leaving untouched`);
        continue;
      }
      await knex('service_completion_profiles').where({ service_key: key }).del();
    }
  }

  // No unlinking here by construction: a row is only removable when the
  // reference count above — which includes scheduled_services and
  // service_records — was zero, so there is nothing to null out.
  if (removableIds.length > 0 && (await knex.schema.hasTable('services'))) {
    await knex('services').whereIn('id', removableIds).del();
  }

  if (await knex.schema.hasTable('system_settings')) {
    // Retained rows keep their provenance so a later roll-forward can
    // reactivate exactly the rows this migration created; a clean rollback
    // (nothing retained) clears the record entirely (exemplar doctrine).
    const retained = state.services.filter((entry) => entry && retainedKeys.has(entry.key));
    if (retained.length > 0) {
      await knex('system_settings').where({ key: STATE_KEY }).update({ value: JSON.stringify({ services: [], profiles: [], retained }) });
      console.warn(`[palm-semiannual] down: recorded ${retained.length} retained row(s) for roll-forward reactivation`);
    } else {
      await knex('system_settings').where({ key: STATE_KEY }).del();
    }
  }
};
