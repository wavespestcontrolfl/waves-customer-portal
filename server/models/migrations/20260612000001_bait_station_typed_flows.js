/**
 * Bait station typed flows (owner spec 2026-06-12).
 *
 * 1. NEW catalog service: rodent_bait_quarterly — the recurring quarterly
 *    exterior rodent bait station check. The catalog previously had only the
 *    one-time setup FEE (rodent_bait_setup) with nothing to schedule the
 *    actual quarterly service against. Price intentionally blank (variable /
 *    manual pricing — owner convention: never default to $0).
 *
 * 2. Completion profiles point the station-work keys at the two new typed
 *    findings flows (rodent_bait_station / termite_bait_station), all at
 *    delivery_mode='internal_only':
 *      - rodent stations ride the rodent-program shadow (graduates with it);
 *      - termite stations stay internal until the FS 482.226 / FAC 5E-14
 *        compliance signoff — NO new termite customer copy ships before the
 *        owner approves it. NOTE: the four recurring termite keys previously
 *        auto-sent GENERIC reports (blank project_type); this trades that
 *        generic customer send for a structured internal one. Zero visits in
 *        the last 12 months — disclosed and accepted.
 *      - termite bonds + renewal are billing/warranty wrappers and are NOT
 *        touched.
 *
 * Per-key resolution follows the self-healed 20260611000012/16 pattern —
 * catalogs are admin-mutable, so no fixed-count assertions: update / insert /
 * heal / loud-skip when the services row is absent.
 *
 * ROLLBACK FIDELITY: up() stamps what it did into the row's notes
 * ([bait_station_action=...], prior mode:type:delivery recorded for updates)
 * and down() restores ONLY what up() changed. The inserted catalog service is
 * deleted on down() only when nothing references it; otherwise deactivated.
 */

const MARKER_RE = / ?\[bait_station_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[bait_station_action=${action}]`;
}

const NEW_SERVICE = {
  service_key: 'rodent_bait_quarterly',
  name: 'Quarterly Rodent Bait Station Service',
  short_name: 'Rodent Bait',
  description: 'Quarterly exterior rodent bait station service: consumption check, rodent evidence, station condition, attractant/harborage review, and bait refresh.',
  category: 'rodent',
  billing_type: 'recurring',
  frequency: 'quarterly',
  visits_per_year: 4,
  default_duration_minutes: 30,
  min_duration_minutes: 20,
  max_duration_minutes: 45,
  pricing_type: 'variable',
  requires_follow_up: false,
  is_taxable: true,
  tax_service_key: 'pest_control',
  requires_license: true,
  license_category: 'GHP',
  min_tech_skill_level: 2,
  icon: '🐀',
  color: '#78716c',
};

// { key, projectType, expect: prior modes accepted for update }
const PROFILE_TARGETS = [
  { key: 'rodent_bait_quarterly', projectType: 'rodent_bait_station', category: 'rodent', billingType: 'recurring' },
  { key: 'rodent_bait_setup', projectType: 'rodent_bait_station', category: 'rodent', billingType: 'one_time' },
  { key: 'termite_bait', projectType: 'termite_bait_station', category: 'termite', billingType: 'recurring' },
  { key: 'termite_active_annual', projectType: 'termite_bait_station', category: 'termite', billingType: 'recurring' },
  { key: 'termite_active_bait_quarterly', projectType: 'termite_bait_station', category: 'termite', billingType: 'recurring' },
  { key: 'termite_monitoring', projectType: 'termite_bait_station', category: 'termite', billingType: 'recurring' },
  { key: 'termite_cartridge_replacement', projectType: 'termite_bait_station', category: 'termite', billingType: 'one_time' },
  { key: 'termite_installation_setup', projectType: 'termite_bait_station', category: 'termite', billingType: 'one_time' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — bait station cutover cannot run');

  // 1. Catalog service (insert-if-absent; admin may have created one).
  const existingService = await knex('services').where({ service_key: NEW_SERVICE.service_key }).first('id');
  if (existingService) {
    console.log(`[bait-station] services.${NEW_SERVICE.service_key}: already exists — leaving catalog row untouched`);
  } else {
    // internal_notes marker = down() only removes a row THIS migration created.
    await knex('services').insert({ ...NEW_SERVICE, internal_notes: '[bait_station_action=inserted]' });
    console.log(`[bait-station] services.${NEW_SERVICE.service_key}: inserted (recurring quarterly, variable price)`);
  }

  // 2. Completion profiles.
  for (const target of PROFILE_TARGETS) {
    const service = await knex('services').where({ service_key: target.key }).first('id', 'name');
    if (!service) {
      console.warn(`[bait-station] ${target.key}: services row ABSENT in this environment — skipping profile`);
      continue;
    }
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (row && !row.active) {
      console.warn(`[bait-station] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (!row) {
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: target.category,
        billing_type: target.billingType,
        completion_mode: 'service_report',
        project_type: target.projectType,
        delivery_mode: 'internal_only',
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        notes: withMarker('', 'inserted'),
      });
      console.log(`[bait-station] ${target.key}: profile inserted → service_report/${target.projectType}/internal_only`);
      continue;
    }
    if (
      row.completion_mode === 'service_report'
      && row.project_type === target.projectType
      && row.delivery_mode === 'internal_only'
    ) {
      console.log(`[bait-station] ${target.key}: already at target — no-op`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        completion_mode: 'service_report',
        project_type: target.projectType,
        delivery_mode: 'internal_only',
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[bait-station] ${target.key}: ${prior} → service_report/${target.projectType}/internal_only (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (hasProfiles) {
    const rows = await knex('service_completion_profiles')
      .whereIn('service_key', PROFILE_TARGETS.map((t) => t.key))
      .select('service_key', 'notes');
    for (const row of rows) {
      const match = String(row.notes || '').match(/\[bait_station_action=([^\]]*)\]/);
      if (!match) continue; // up() never touched this row
      const action = match[1];
      if (action === 'inserted') {
        await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
        console.log(`[bait-station:down] ${row.service_key}: inserted profile deleted`);
        continue;
      }
      const prior = action.match(/^updated:([^:]+):([^:]+):([^:]+)$/);
      if (prior) {
        await knex('service_completion_profiles')
          .where({ service_key: row.service_key })
          .update({
            completion_mode: prior[1] === '-' ? null : prior[1],
            project_type: prior[2] === '-' ? null : prior[2],
            delivery_mode: prior[3] === '-' ? null : prior[3],
            notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
            updated_at: knex.fn.now(),
          });
        console.log(`[bait-station:down] ${row.service_key}: restored ${prior[1]}/${prior[2]}/${prior[3]}`);
      }
    }
  }

  // Catalog service: only rows THIS migration created (internal_notes
  // marker) — never an admin-created row. Delete only when unreferenced;
  // otherwise deactivate so history stays intact.
  const service = await knex('services')
    .where({ service_key: NEW_SERVICE.service_key })
    .where('internal_notes', 'like', '%[bait_station_action=inserted]%')
    .first('id');
  if (service) {
    const [{ count }] = await knex('scheduled_services').where({ service_id: service.id }).count('id as count');
    if (Number(count) === 0) {
      await knex('services').where({ id: service.id }).del();
      console.log(`[bait-station:down] services.${NEW_SERVICE.service_key}: deleted (unreferenced)`);
    } else {
      await knex('services').where({ id: service.id }).update({ is_active: false, updated_at: knex.fn.now() });
      console.warn(`[bait-station:down] services.${NEW_SERVICE.service_key}: ${count} scheduled service(s) reference it — deactivated instead of deleted`);
    }
  }
};
