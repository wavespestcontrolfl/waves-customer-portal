/**
 * Phase-B straggler cutovers: the last four project_required keys with
 * live typed forms flip to the universal typed completion flow, plus the
 * palm_treatment repoint (universal one-time services plan §5 Phase B,
 * ratified 2026-07-12 — Q2 bed-bug copy approved, Q3 cockroach flip,
 * wildlife form built dark since feat/service-sectioned-findings,
 * one_time_pest_control found by the B0 scan).
 *
 *   wildlife_trapping     project_required → service_report / wildlife_trapping
 *   cockroach_control     project_required → service_report / cockroach
 *   bed_bug_treatment     project_required → service_report / bed_bug
 *   one_time_pest_control project_required → service_report / one_time_pest_treatment
 *   palm_treatment        service_report/NULL → service_report / palm_injection
 *                         (owner 2026-07-12; archived key — self-heals if absent)
 *
 * All five keep/gain delivery_mode auto_send (all already auto_send in prod,
 * verified read-only 2026-07-12): wildlife/bed-bug/cockroach customers get
 * project-flow sends today, so typed auto-send replaces like-for-like;
 * bed_bug_treatment stays customer_visible:false in the catalog (Q2 —
 * visibility is a separate owner call; the profile flip only changes what a
 * completion renders/sends).
 *
 * Self-healing per-key (the 20260611000012 pattern — env catalogs are
 * admin-mutable, no fixed-count assertions): absent → loud skip; inactive →
 * loud skip; already at target → no-op; unexpected pointer → loud skip
 * (cutover must never clobber an admin's manual repoint).
 *
 * ROLLBACK FIDELITY: up() stamps [straggler_cutover_action=...] with the
 * prior mode/type/delivery into the row's notes; down() restores exactly
 * those rows and strips the marker.
 */

const MARKER_RE = / ?\[straggler_cutover_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[straggler_cutover_action=${action}]`;
}

// key → { fromMode, acceptedTypes, toType }. acceptedTypes are the pointers
// we expect to find (prod-verified); anything else is admin drift → skip.
const CUTOVERS = [
  { key: 'wildlife_trapping', fromMode: 'project_required', acceptedTypes: ['wildlife_trapping'], toType: 'wildlife_trapping' },
  { key: 'cockroach_control', fromMode: 'project_required', acceptedTypes: ['cockroach'], toType: 'cockroach' },
  { key: 'bed_bug_treatment', fromMode: 'project_required', acceptedTypes: ['bed_bug'], toType: 'bed_bug' },
  { key: 'one_time_pest_control', fromMode: 'project_required', acceptedTypes: ['one_time_pest_treatment'], toType: 'one_time_pest_treatment' },
  // palm_treatment is already service_report but generic (NULL pointer) —
  // fromMode reflects that; a non-null pointer means someone already decided.
  { key: 'palm_treatment', fromMode: 'service_report', acceptedTypes: [null], toType: 'palm_injection' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[straggler-cutover] service_completion_profiles table absent — skipping');
    return;
  }
  for (const target of CUTOVERS) {
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (!row) {
      console.warn(`[straggler-cutover] ${target.key}: profile row ABSENT in this environment — skipping`);
      continue;
    }
    if (!row.active) {
      console.warn(`[straggler-cutover] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode === 'service_report' && row.project_type === target.toType) {
      console.log(`[straggler-cutover] ${target.key}: already at target — no-op`);
      continue;
    }
    if (row.completion_mode !== target.fromMode || !target.acceptedTypes.includes(row.project_type)) {
      console.warn(`[straggler-cutover] ${target.key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (cutover never clobbers drifted pointers)`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        completion_mode: 'service_report',
        project_type: target.toType,
        delivery_mode: 'auto_send',
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[straggler-cutover] ${target.key}: ${prior} → service_report/${target.toType}/auto_send (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', CUTOVERS.map((c) => c.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[straggler_cutover_action=updated:([^\]]*)\]/);
    if (!match) continue;
    const [mode, type, delivery] = match[1].split(':').map((v) => (v === '-' ? null : v));
    await knex('service_completion_profiles')
      .where({ service_key: row.service_key })
      .update({
        completion_mode: mode,
        project_type: type,
        delivery_mode: delivery,
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
    console.log(`[straggler-cutover:down] ${row.service_key}: restored ${mode || 'NULL'}/${type || 'NULL'}/${delivery || 'NULL'}`);
  }
};
