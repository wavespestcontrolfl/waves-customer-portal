/**
 * Combined service cutover (combined-service-completions.md, owner directive
 * 2026-06-12): light up the dark companion mechanism (#1697) for the three
 * owner-named combined services.
 *
 * 1. THREE new catalog services (insert-if-absent). Names are the customer-
 *    facing combined names — "Pest & Rodent Control" matches the existing
 *    prod scheduled_services rows verbatim so name-based profile resolution
 *    works even before the service_id link below. Prices intentionally blank
 *    (variable / manual pricing — owner convention: never default to $0).
 *
 * 2. THREE completion profiles, each a standard recurring primary
 *    (service_report, no findingsType — pest or lawn line detected from the
 *    name) carrying companion_types:
 *      - pest_rodent_quarterly      → rodent_bait_station @ internal_only
 *        (rodent family is still in shadow; graduates WITH the rodent-family
 *        review — that graduation migration must flip this companion entry
 *        too, see the design doc's graduation recipe)
 *      - pest_termite_bait_quarterly → termite_bait_station @ auto_send
 *        (termite bait graduated 20260612000023 on the FS 482.226 /
 *        FAC 5E-14 compliance signoff)
 *      - lawn_tree_shrub_combo      → tree_shrub @ auto_send
 *        (T&S customer reports have always auto-sent)
 *
 * 3. Link the existing combined-name scheduled_services rows ("Pest & Rodent
 *    Control", expected 4 customers incl. Waters) to the new catalog row via
 *    service_id. Name-matched, self-healed against live state — counts are
 *    logged, never asserted (the #1617 lesson).
 *
 * ROLLBACK FIDELITY: up() stamps [combined_cutover_action=...] markers into
 * profile notes, catalog internal_notes, and scheduled_services
 * INTERNAL_notes (NEVER scheduled_services.notes — that column is returned
 * to customers by GET /api/schedule and rendered as appointment notes in
 * the scheduling UI); down() restores ONLY marked rows.
 */

const MARKER_RE = / ?\[combined_cutover_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[combined_cutover_action=${action}]`;
}

const NEW_SERVICES = [
  {
    service_key: 'pest_rodent_quarterly',
    name: 'Pest & Rodent Control',
    short_name: 'Pest & Rodent',
    description: 'Quarterly perimeter pest treatment combined with exterior rodent bait station service: one visit, one report — pest treatment plus consumption check, rodent evidence, station condition, and bait refresh.',
    category: 'pest_control',
    billing_type: 'recurring',
    frequency: 'quarterly',
    visits_per_year: 4,
    default_duration_minutes: 60,
    min_duration_minutes: 40,
    max_duration_minutes: 90,
    pricing_type: 'variable',
    is_waveguard: true,
    requires_follow_up: false,
    is_taxable: true,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 2,
    icon: '🐜',
    color: '#0ea5e9',
  },
  {
    service_key: 'pest_termite_bait_quarterly',
    name: 'Quarterly Pest + Termite Bait Station',
    short_name: 'Pest + Termite Bait',
    description: 'Quarterly perimeter pest treatment combined with termite bait station monitoring: one visit, one report — pest treatment plus station checks, activity/consumption readings, and station actions.',
    category: 'pest_control',
    billing_type: 'recurring',
    frequency: 'quarterly',
    visits_per_year: 4,
    default_duration_minutes: 75,
    min_duration_minutes: 50,
    max_duration_minutes: 120,
    pricing_type: 'variable',
    is_waveguard: true,
    requires_follow_up: false,
    is_taxable: true,
    tax_service_key: 'pest_control',
    requires_license: true,
    license_category: 'GHP',
    min_tech_skill_level: 3,
    icon: '🐜',
    color: '#0ea5e9',
  },
  {
    service_key: 'lawn_tree_shrub_combo',
    name: 'Lawn + Tree & Shrub',
    short_name: 'Lawn + T&S',
    description: 'Bi-monthly lawn fertilization and weed control combined with ornamental tree & shrub care: one visit, one report — turf application plus T&S inspection, treatment, and findings.',
    category: 'lawn_care',
    billing_type: 'recurring',
    frequency: 'bimonthly',
    visits_per_year: 6,
    default_duration_minutes: 90,
    min_duration_minutes: 60,
    max_duration_minutes: 150,
    pricing_type: 'variable',
    is_waveguard: true,
    requires_follow_up: false,
    is_taxable: true,
    tax_service_key: 'lawn_care',
    requires_license: true,
    license_category: 'L&O',
    min_tech_skill_level: 2,
    icon: '🌿',
    color: '#10b981',
  },
];

// Companion delivery mirrors each type's CURRENT standalone graduation state.
const PROFILE_TARGETS = [
  {
    key: 'pest_rodent_quarterly',
    category: 'pest_control',
    billingType: 'recurring',
    companions: [{ type: 'rodent_bait_station', delivery: 'internal_only' }],
  },
  {
    key: 'pest_termite_bait_quarterly',
    category: 'pest_control',
    billingType: 'recurring',
    companions: [{ type: 'termite_bait_station', delivery: 'auto_send' }],
  },
  {
    key: 'lawn_tree_shrub_combo',
    category: 'lawn_care',
    billingType: 'recurring',
    companions: [{ type: 'tree_shrub', delivery: 'auto_send' }],
  },
];

// Existing prod rows to link to pest_rodent_quarterly. Lowercased, trimmed.
const COMBINED_NAME_MATCHES = ['pest & rodent control', 'pest and rodent control'];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — combined cutover cannot run');

  // 1. Catalog services (insert-if-absent; admin may have created one).
  for (const svc of NEW_SERVICES) {
    const existing = await knex('services').where({ service_key: svc.service_key }).first('id');
    if (existing) {
      console.log(`[combined-cutover] services.${svc.service_key}: already exists — leaving catalog row untouched`);
      continue;
    }
    await knex('services').insert({ ...svc, internal_notes: '[combined_cutover_action=inserted]' });
    console.log(`[combined-cutover] services.${svc.service_key}: inserted ("${svc.name}", ${svc.frequency}, variable price)`);
  }

  // 2. Completion profiles with companion_types.
  for (const target of PROFILE_TARGETS) {
    const service = await knex('services').where({ service_key: target.key }).first('id', 'name');
    if (!service) {
      console.warn(`[combined-cutover] ${target.key}: services row ABSENT — skipping profile`);
      continue;
    }
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (row && !row.active) {
      console.warn(`[combined-cutover] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    const companionJson = JSON.stringify(target.companions);
    if (!row) {
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: target.category,
        billing_type: target.billingType,
        completion_mode: 'service_report',
        project_type: null,
        delivery_mode: 'auto_send',
        companion_types: companionJson,
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        notes: withMarker('', 'inserted'),
      });
      console.log(`[combined-cutover] ${target.key}: profile inserted → service_report/auto_send + companions ${companionJson}`);
      continue;
    }
    if (row.companion_types) {
      console.warn(`[combined-cutover] ${target.key}: profile already carries companion_types — leaving untouched`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        companion_types: companionJson,
        notes: withMarker(row.notes, 'companions_added'),
        updated_at: knex.fn.now(),
      });
    console.log(`[combined-cutover] ${target.key}: companions added to existing profile → ${companionJson}`);
  }

  // 3. Link existing combined-name scheduled services (expected: the 4
  //    "Pest & Rodent Control" customers incl. Waters; Harris's separate
  //    pest + rodent rows are NOT name-matched and stay as-is pending the
  //    owner's mapping decision).
  const combined = await knex('services').where({ service_key: 'pest_rodent_quarterly' }).first('id');
  if (!combined) {
    console.warn('[combined-cutover] pest_rodent_quarterly catalog row missing — skipping scheduled_services link');
    return;
  }
  const rows = await knex('scheduled_services')
    .whereRaw('lower(btrim(service_type)) in (?, ?)', COMBINED_NAME_MATCHES)
    .where((q) => q.whereNull('service_id').orWhereNot('service_id', combined.id))
    .select('id', 'customer_id', 'service_id', 'internal_notes', 'status');
  if (!rows.length) {
    console.log('[combined-cutover] scheduled_services: no combined-name rows needing a link (0 found)');
    return;
  }
  const customers = new Set(rows.map((r) => r.customer_id).filter(Boolean));
  for (const row of rows) {
    // Marker goes in internal_notes — scheduled_services.notes is
    // customer-visible (GET /api/schedule) and editable as appointment notes.
    await knex('scheduled_services')
      .where({ id: row.id })
      .update({
        service_id: combined.id,
        internal_notes: withMarker(row.internal_notes, `linked:${row.service_id || '-'}`),
        updated_at: knex.fn.now(),
      });
  }
  console.log(`[combined-cutover] scheduled_services: linked ${rows.length} row(s) across ${customers.size} customer(s) to pest_rodent_quarterly (prior service_id recorded per row)`);
};

exports.down = async function down(knex) {
  // 3. Unlink scheduled_services rows THIS migration linked.
  const marked = await knex('scheduled_services')
    .where('internal_notes', 'like', '%[combined_cutover_action=linked:%')
    .select('id', 'internal_notes');
  for (const row of marked) {
    const match = String(row.internal_notes || '').match(/\[combined_cutover_action=linked:([^\]]*)\]/);
    if (!match) continue;
    const prior = match[1] === '-' ? null : match[1];
    await knex('scheduled_services')
      .where({ id: row.id })
      .update({
        service_id: prior,
        internal_notes: String(row.internal_notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
  }
  if (marked.length) console.log(`[combined-cutover:down] scheduled_services: restored ${marked.length} row(s)`);

  // 2. Profiles.
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (hasProfiles) {
    const rows = await knex('service_completion_profiles')
      .whereIn('service_key', PROFILE_TARGETS.map((t) => t.key))
      .select('service_key', 'notes');
    for (const row of rows) {
      const match = String(row.notes || '').match(/\[combined_cutover_action=([^\]]*)\]/);
      if (!match) continue;
      if (match[1] === 'inserted') {
        await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
        console.log(`[combined-cutover:down] ${row.service_key}: inserted profile deleted`);
      } else if (match[1] === 'companions_added') {
        await knex('service_completion_profiles')
          .where({ service_key: row.service_key })
          .update({
            companion_types: null,
            notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
            updated_at: knex.fn.now(),
          });
        console.log(`[combined-cutover:down] ${row.service_key}: companion_types cleared`);
      }
    }
  }

  // 1. Catalog rows THIS migration created — delete only when NOTHING
  //    references them. service_records.service_id is ON DELETE SET NULL,
  //    so deleting a row with completed-service history would silently null
  //    the historical link — count BOTH tables; deactivate when either has
  //    rows so history stays intact.
  for (const svc of NEW_SERVICES) {
    const service = await knex('services')
      .where({ service_key: svc.service_key })
      .where('internal_notes', 'like', '%[combined_cutover_action=inserted]%')
      .first('id');
    if (!service) continue;
    const [{ count: scheduledCount }] = await knex('scheduled_services').where({ service_id: service.id }).count('id as count');
    const [{ count: recordCount }] = await knex('service_records').where({ service_id: service.id }).count('id as count');
    if (Number(scheduledCount) === 0 && Number(recordCount) === 0) {
      await knex('services').where({ id: service.id }).del();
      console.log(`[combined-cutover:down] services.${svc.service_key}: deleted (unreferenced)`);
    } else {
      await knex('services').where({ id: service.id }).update({ is_active: false, updated_at: knex.fn.now() });
      console.warn(`[combined-cutover:down] services.${svc.service_key}: ${scheduledCount} scheduled + ${recordCount} completed record(s) reference it — deactivated instead of deleted`);
    }
  }
};
