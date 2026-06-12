/**
 * Rodent family typed cutover (owner spec 2026-06-12, Phase 2 §§1–4,
 * Priority 3). Flips the 11 remaining project_required rodent keys to the
 * typed service-report flow, each on the form that tells ITS service story
 * (owner critique: never flatten everything into "rodent service
 * completed"):
 *
 *   rodent_exclusion, rodent_exclusion_only        → rodent_exclusion
 *   rodent_sanitation_light/standard/heavy         → rodent_sanitation
 *   rodent_trapping_exclusion / _sanitation /
 *   _exclusion_sanitation / _followup              → rodent_trapping
 *                                  (base checklist + combo modules served
 *                                   per service key — see
 *                                   TYPE_MODULE_SECTIONS)
 *   rodent_inspection, rodent_general_one_time     → rodent_inspection
 *
 * delivery_mode = internal_only: the whole family rides the rodent shadow
 * and graduates to auto_send WITH rodent_trapping after the owner's stored-
 * report review. DISCLOSED TRADE: these keys currently auto-send reports
 * through the project flow; until graduation those sends stop (same
 * disclosed posture as the termite station keys in 20260612000001).
 *
 * Self-healed pattern (20260611000012/16): update / insert / heal /
 * loud-skip. ROLLBACK FIDELITY: up() stamps prior mode:type:delivery into
 * the row's notes marker; down() restores ONLY what up() changed.
 */

const MARKER_RE = / ?\[rodent_family_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[rodent_family_action=${action}]`;
}

const TARGETS = [
  { key: 'rodent_exclusion', projectType: 'rodent_exclusion' },
  { key: 'rodent_exclusion_only', projectType: 'rodent_exclusion' },
  { key: 'rodent_sanitation_light', projectType: 'rodent_sanitation' },
  { key: 'rodent_sanitation_standard', projectType: 'rodent_sanitation' },
  { key: 'rodent_sanitation_heavy', projectType: 'rodent_sanitation' },
  { key: 'rodent_trapping_exclusion', projectType: 'rodent_trapping' },
  { key: 'rodent_trapping_sanitation', projectType: 'rodent_trapping' },
  { key: 'rodent_trapping_exclusion_sanitation', projectType: 'rodent_trapping' },
  { key: 'rodent_trapping_followup', projectType: 'rodent_trapping' },
  { key: 'rodent_inspection', projectType: 'rodent_inspection' },
  { key: 'rodent_general_one_time', projectType: 'rodent_inspection' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — rodent family cutover cannot run');

  for (const target of TARGETS) {
    const service = await knex('services').where({ service_key: target.key }).first('id', 'name', 'category', 'billing_type');
    if (!service) {
      console.warn(`[rodent-family] ${target.key}: services row ABSENT in this environment — skipping profile`);
      continue;
    }
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (row && !row.active) {
      console.warn(`[rodent-family] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (!row) {
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: 'rodent',
        billing_type: service.billing_type || 'one_time',
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
      console.log(`[rodent-family] ${target.key}: profile inserted → service_report/${target.projectType}/internal_only`);
      continue;
    }
    if (
      row.completion_mode === 'service_report'
      && row.project_type === target.projectType
      && row.delivery_mode === 'internal_only'
    ) {
      console.log(`[rodent-family] ${target.key}: already at target — no-op`);
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
    console.log(`[rodent-family] ${target.key}: ${prior} → service_report/${target.projectType}/internal_only (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', TARGETS.map((t) => t.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[rodent_family_action=([^\]]*)\]/);
    if (!match) continue; // up() never touched this row
    const action = match[1];
    if (action === 'inserted') {
      await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
      console.log(`[rodent-family:down] ${row.service_key}: inserted profile deleted`);
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
      console.log(`[rodent-family:down] ${row.service_key}: restored ${prior[1]}/${prior[2]}/${prior[3]}`);
    }
  }
};
