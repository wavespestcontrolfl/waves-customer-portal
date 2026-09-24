/**
 * Mosquito Misting System: lead-only catalog row for the new automatic
 * mosquito misting system pages (install + monthly service plan).
 *
 * Background (2026-09-24): Waves now has live website pages for automatic
 * mosquito misting systems, but there is no pricing yet — misting is quoted
 * after an on-site design visit (equipment placement, nozzle count, line
 * run). Leads from those pages must be recorded as misting, not folded into
 * barrier "mosquito control" (mosquito_monthly / mosquito_one_time /
 * mosquito_seasonal). This row exists so the public quote form can capture
 * that lead identity distinctly.
 *
 * public_quote_selectable=true with NO PUBLIC_QUOTE_REQUESTS entry
 * (server/services/public-services-menu.js) is the existing quote-on-request
 * mechanism (CLAUDE.md rule 15 — reuse, don't build a new one):
 * publicSelectableService finds the row selectable-but-not-instant,
 * server/routes/public-quote.js calls quoteOnRequestEstimate instead of the
 * pricing engine, and the lead is written with service_key =
 * 'mosquito_misting_system' + service_interest = the catalog name verbatim.
 * Do NOT add this key to PUBLIC_QUOTE_REQUESTS — there is no engine pricer
 * for it yet.
 *
 * booking_enabled false (design-visit-first, never self-bookable cold —
 * same posture as bed_bug_treatment/palm_injection). No price fields: this
 * is the honest-NULL convention other quote-on-request rows already use
 * (palm_injection_semiannual, mosquito_one_time before its ladder migration)
 * — base_price/price_range_min/price_range_max all NULL, pricing_type
 * 'variable' (the catalog's marker for "not a flat number"; the actual
 * "no pricer yet" fact lives in internal_notes since there is no dedicated
 * pricing_type value for it).
 *
 * public_quote_selectable is set directly in the INSERT (not a separate
 * seed-and-flip update) because this is a brand-new row: there is no
 * pre-existing admin choice to preserve, only a skip-if-exists guard.
 * Self-healing + reversible, same contract as 20260808080000
 * (estimate-gap catalog rows) and 20260811000010 (palm semiannual): skip
 * pre-existing row, heal profile only for an explicitly-active row, record
 * the inserted UUID in a system_settings state row, down() removes by
 * recorded UUID only and only when nothing references it.
 */

const SERVICES = [
  {
    service_key: 'mosquito_misting_system',
    name: 'Mosquito Misting System Service',
    short_name: 'Misting System',
    description: 'Automatic mosquito misting system — install and monthly service plan. Designed and priced after an on-site visit; no published price.',
    category: 'mosquito',
    billing_type: 'one_time',
    frequency: null,
    visits_per_year: null,
    default_duration_minutes: 60,
    min_duration_minutes: 30,
    max_duration_minutes: 120,
    pricing_type: 'variable',
    base_price: null,
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
    public_quote_selectable: true,
    is_active: true,
    is_archived: false,
    icon: '🦟',
    color: '#0ea5e9',
    sort_order: 24,
    internal_notes: 'Lead-only: priced after on-site design visit; no engine pricer yet (2026-09-24).',
  },
];

const STATE_KEY = 'migration.20260924000020.state';
const PROFILE_MARKER = '[mosquito_misting_catalog_action=inserted]';

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
    console.warn('[mosquito-misting-catalog] services table absent — skipping');
    return;
  }
  if (!(await knex.schema.hasColumn('services', 'public_quote_selectable'))) {
    console.warn('[mosquito-misting-catalog] services.public_quote_selectable column absent — skipping (needs 20260829000020 first)');
    return;
  }

  const inserted = { services: [], profiles: [] };

  for (const svc of SERVICES) {
    const exists = await knex('services').where({ service_key: svc.service_key }).first();
    if (exists) {
      console.warn(`[mosquito-misting-catalog] ${svc.service_key}: services row already exists — leaving untouched`);
      continue;
    }
    const returned = await knex('services').insert(svc).returning('id');
    const first = Array.isArray(returned) ? returned[0] : returned;
    const newId = first && typeof first === 'object' ? first.id : first;
    if (newId) {
      inserted.services.push({ key: svc.service_key, id: newId });
      console.log(`[mosquito-misting-catalog] ${svc.service_key}: services row inserted (${newId})`);
    } else {
      // No UUID back means down() cannot prove ownership — leave the row
      // out of the removable set rather than guessing by key.
      console.warn(`[mosquito-misting-catalog] ${svc.service_key}: inserted but no id returned — row will survive rollback`);
    }
  }

  if (!(await knex.schema.hasTable('service_completion_profiles'))) {
    console.warn('[mosquito-misting-catalog] service_completion_profiles table absent — skipping profiles');
    await recordState(knex, inserted);
    return;
  }

  for (const svc of SERVICES) {
    const service = await knex('services').where({ service_key: svc.service_key }).first();
    if (!service) {
      console.warn(`[mosquito-misting-catalog] ${svc.service_key}: services row absent after insert pass — skipping profile`);
      continue;
    }
    // An admin-deactivated/archived row keeps its posture — explicitly
    // true only: NULL is_active reads as inactive in every catalog
    // filter, and profile resolution never re-checks active state. Rows
    // this migration just inserted always carry is_active: true.
    if (service.is_active !== true || service.is_archived === true) {
      console.warn(`[mosquito-misting-catalog] ${svc.service_key}: services row is not explicitly active (or archived) — skipping profile (admin decision preserved)`);
      continue;
    }
    const existing = await knex('service_completion_profiles')
      .where({ service_key: svc.service_key })
      .first();
    if (existing) {
      console.warn(`[mosquito-misting-catalog] ${svc.service_key}: completion profile already exists — leaving untouched`);
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
      // Generic typed report (NULL project_type) — no on-site work has
      // happened yet at the lead stage; this row is never scheduled or
      // completed until it is priced, so the estate-wide one-time posture
      // (service_report/token_only/recurring_customer) is a placeholder
      // that carries no field-work assumption.
      completion_mode: 'service_report',
      project_type: null,
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
    console.log(`[mosquito-misting-catalog] ${svc.service_key}: profile inserted → service_report/generic/auto_send`);
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
        console.warn(`[mosquito-misting-catalog] down: unreadable state row (${e.message}) — removing nothing`);
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
  //    identity and typed-completion linkage.
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
    if (await knex.schema.hasTable('leads') && await knex.schema.hasColumn('leads', 'service_key')) {
      refs += (await knex('leads').where({ service_key: entry.key }).pluck('id')).length;
    }
    // Name-only references count too — same alias sweep as the estimate-gap
    // and palm-semiannual exemplars.
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
      // The SERVICE row deactivates (stops being offered — the rollback's
      // intent); its PROFILE stays active untouched: leads/visits that
      // forced retention still resolve through it.
      retainedKeys.add(entry.key);
      await knex('services').where({ id: entry.id }).update({ is_active: false });
      console.warn(`[mosquito-misting-catalog] down: ${entry.key} (${entry.id}) has ${refs} reference(s) — service retained+deactivated, profile left active (links keep resolving)`);
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
        console.warn(`[mosquito-misting-catalog] down: profile ${key} serves an admin-recreated service row (${currentService.id}) — leaving untouched`);
        continue;
      }
      const profile = await knex('service_completion_profiles').where({ service_key: key }).first();
      if (!profile) continue;
      if (!String(profile.notes || '').includes(PROFILE_MARKER)) {
        console.warn(`[mosquito-misting-catalog] down: profile ${key} lacks the insertion marker — admin-replaced, leaving untouched`);
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
