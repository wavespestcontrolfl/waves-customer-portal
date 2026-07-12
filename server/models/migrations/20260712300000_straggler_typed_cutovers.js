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
 * admin-mutable, no fixed-count assertions):
 *  - services row absent → loud skip (nothing to cut over here)
 *  - profile row absent but services row LIVE → HEAL: insert the target
 *    typed profile (Codex round-1: admin-created catalog rows get no
 *    profile, so a skip would leave them on the generic fallback forever)
 *  - profile inactive → loud skip; unexpected pointer → loud skip (cutover
 *    never clobbers an admin's manual repoint)
 *  - already at target mode+pointer: delivery internal_only heals to
 *    auto_send (Codex round-1 — partial-rollout drift); delivery
 *    'disabled' loud-skips (kill switches stay fail-closed); auto_send
 *    no-ops
 *
 * ROLLBACK FIDELITY: up() stamps [straggler_cutover_action=...] with the
 * prior mode/type/delivery into the row's notes (healed inserts stamp
 * `inserted` and are deleted by down()); down() restores exactly those
 * rows and strips the marker.
 */

const MARKER_RE = / ?\[straggler_cutover_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[straggler_cutover_action=${action}]`;
}

// key → { fromMode, acceptedTypes, toType, category }. acceptedTypes are
// the pointers we expect to find (prod-verified); anything else is admin
// drift → skip. category feeds the heal-insert when the profile is missing.
const CUTOVERS = [
  { key: 'wildlife_trapping', fromMode: 'project_required', acceptedTypes: ['wildlife_trapping'], toType: 'wildlife_trapping', category: 'specialty' },
  { key: 'cockroach_control', fromMode: 'project_required', acceptedTypes: ['cockroach'], toType: 'cockroach', category: 'pest_control' },
  { key: 'bed_bug_treatment', fromMode: 'project_required', acceptedTypes: ['bed_bug'], toType: 'bed_bug', category: 'specialty' },
  { key: 'one_time_pest_control', fromMode: 'project_required', acceptedTypes: ['one_time_pest_treatment'], toType: 'one_time_pest_treatment', category: 'pest_control' },
  // palm_treatment is already service_report but generic (NULL pointer) —
  // fromMode reflects that; a non-null pointer means someone already decided.
  { key: 'palm_treatment', fromMode: 'service_report', acceptedTypes: [null], toType: 'palm_injection', category: 'tree_shrub' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[straggler-cutover] service_completion_profiles table absent — skipping');
    return;
  }
  const hasServices = await knex.schema.hasTable('services');
  for (const target of CUTOVERS) {
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (!row) {
      // Heal: an admin-created catalog row (service-library createService
      // inserts only into services) has no profile — without one the
      // resolver falls back to the generic no-findingsType profile and the
      // typed billing pre-gate never engages. Insert the target profile
      // when the services row is live; skip only when the service itself
      // is absent.
      const service = hasServices
        ? await knex('services').where({ service_key: target.key }).first('name', 'billing_type', 'requires_follow_up', 'follow_up_interval_days', 'is_active', 'is_archived')
        : null;
      if (!service) {
        console.warn(`[straggler-cutover] ${target.key}: no services row and no profile in this environment — skipping`);
        continue;
      }
      // Follow-up policy rides the catalog row (Codex r2): the seeded
      // profiles for these keys carry alert/interval (two-treatment
      // cockroach 14d, bed bug 14d, wildlife 1d) — a healed profile
      // hard-coded to 'none' would silently drop the included follow-up
      // CTA/booking gate.
      const followupPolicy = service.requires_follow_up ? 'alert' : 'none';
      const followupDays = service.requires_follow_up
        ? (Number(service.follow_up_interval_days) || 14)
        : null;
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: target.category,
        billing_type: service.billing_type || 'one_time',
        completion_mode: 'service_report',
        project_type: target.toType,
        delivery_mode: 'auto_send',
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: followupPolicy,
        default_followup_days: followupDays,
        active: true,
        notes: withMarker('', 'inserted'),
      });
      console.log(`[straggler-cutover] ${target.key}: profile inserted → service_report/${target.toType}/auto_send (followup ${followupPolicy}${followupDays ? `/${followupDays}d` : ''})`);
      continue;
    }
    if (!row.active) {
      console.warn(`[straggler-cutover] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode === 'service_report' && row.project_type === target.toType) {
      // Mode + pointer already at target — heal drifted delivery posture
      // (Codex round-1), but never lift a 'disabled' kill switch.
      if (row.delivery_mode === 'auto_send') {
        console.log(`[straggler-cutover] ${target.key}: already at target — no-op`);
      } else if (row.delivery_mode === 'internal_only') {
        await knex('service_completion_profiles')
          .where({ service_key: target.key })
          .update({
            delivery_mode: 'auto_send',
            notes: withMarker(row.notes, `updated:service_report:${row.project_type}:internal_only`),
            updated_at: knex.fn.now(),
          });
        console.log(`[straggler-cutover] ${target.key}: pointer already at target, delivery internal_only → auto_send (prior recorded)`);
      } else {
        console.warn(`[straggler-cutover] ${target.key}: delivery_mode='${row.delivery_mode || 'NULL'}' — skipping (kill switches stay fail-closed)`);
      }
      continue;
    }
    if (row.completion_mode !== target.fromMode || !target.acceptedTypes.includes(row.project_type)) {
      console.warn(`[straggler-cutover] ${target.key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (cutover never clobbers drifted pointers)`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    // A pre-existing 'disabled' kill switch survives the mode/pointer flip
    // (Codex r2) — after cutover the typed path DOES consult delivery_mode,
    // so overwriting it would re-enable customer sends someone turned off.
    const targetDelivery = row.delivery_mode === 'disabled' ? 'disabled' : 'auto_send';
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        completion_mode: 'service_report',
        project_type: target.toType,
        delivery_mode: targetDelivery,
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[straggler-cutover] ${target.key}: ${prior} → service_report/${target.toType}/${targetDelivery} (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', CUTOVERS.map((c) => c.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[straggler_cutover_action=([^\]]*)\]/);
    if (!match) continue;
    if (match[1] === 'inserted') {
      await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
      console.log(`[straggler-cutover:down] ${row.service_key}: healed insert removed`);
      continue;
    }
    const updateMatch = match[1].match(/^updated:(.*)$/);
    if (!updateMatch) continue;
    const [mode, type, delivery] = updateMatch[1].split(':').map((v) => (v === '-' ? null : v));
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
