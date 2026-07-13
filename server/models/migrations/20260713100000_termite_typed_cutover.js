/**
 * Termite family typed cutover: the five FS 482 / FAC 5E-14 pending-review
 * keys flip from the Projects (Jobs) flow to the universal typed completion
 * flow (universal one-time services plan §5, Q5 ratified 2026-07-12 — the
 * cutover was blocked on the owner's compliance review of the inspection +
 * remedial lanes; unblocked by the Phase-3 compliance fields + send gates,
 * owner signoff 2026-07-13, #2703).
 *
 *   termite_inspection      project_required → service_report / termite_inspection
 *   termite_spot_treatment  project_required → service_report / termite_treatment
 *   termite_pretreatment    project_required → service_report / termite_treatment
 *   termite_trenching       special_project  → service_report / termite_treatment
 *   termite_liquid          special_project  → service_report / termite_treatment
 *
 * FIELD PARITY IS THE CONTRACT (owner directive 2026-07-13: the fields
 * carried over from the Jobs/project report must be exact and the same).
 * Every key keeps the exact project_type pointer its Create Project Report
 * flow used (seeded 20260521000005), so the typed completion form and the
 * customer report render from the SAME PROJECT_TYPES findings schema —
 * same keys, labels, options, sections, and required rules
 * (REQUIRED_FINDINGS_FIELDS + the Phase-3 requiredUnless/contradiction
 * gates, enforced by validateTypedFindings on this path exactly as
 * evaluateProjectSendReadiness enforces them on the project path). Pinned
 * by tests/termite-typed-cutover-parity.test.js.
 *
 * All five gain delivery_mode auto_send: termite customers already receive
 * project-flow report sends today, so typed auto-send replaces
 * like-for-like, and completion hard-blocks until the compliance fields
 * are filled. WDO + the pre-treat certificate (compliance projects,
 * COMPLIANCE_PROJECT_KEYS) are NOT touched — their FDACS-13645 / FBC
 * pipelines stay on the project flow, enforced in code by
 * V1_EXCLUDED_PROJECT_TYPES.
 *
 * Self-healing per-key (the 20260712300000 straggler pattern — env
 * catalogs are admin-mutable, no fixed-count assertions):
 *  - services row absent → loud skip (nothing to cut over here)
 *  - profile row absent but services row LIVE → HEAL: insert the target
 *    typed profile (admin-created catalog rows get no profile, so a skip
 *    would leave them on the generic fallback forever)
 *  - profile inactive → loud skip; unexpected mode/pointer → loud skip
 *    (cutover never clobbers an admin's manual repoint)
 *  - already at target mode+pointer: delivery internal_only heals to
 *    auto_send (partial-rollout drift); delivery 'disabled' loud-skips
 *    (kill switches stay fail-closed); auto_send no-ops
 *
 * ROLLBACK FIDELITY: up() stamps [termite_cutover_action=...] with the
 * prior mode/type/delivery into the row's notes (healed inserts stamp
 * `inserted` and are deleted by down()); down() restores exactly those
 * rows and strips the marker.
 */

const MARKER_RE = / ?\[termite_cutover_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[termite_cutover_action=${action}]`;
}

// key → { fromMode, acceptedTypes, toType, category }. fromMode/acceptedTypes
// are the exact prod shapes seeded by 20260521000005 (verified against the
// seed's SPECIAL_PROJECT_TYPES + PROJECT_TYPE_BY_SERVICE_KEY); anything else
// is admin drift → skip. toType === the accepted pointer on every key: the
// flip is MODE-ONLY, which is what guarantees the Jobs-form/typed-form field
// parity. category feeds the heal-insert when the profile is missing.
const CUTOVERS = [
  { key: 'termite_inspection', fromMode: 'project_required', acceptedTypes: ['termite_inspection'], toType: 'termite_inspection', category: 'termite' },
  { key: 'termite_spot_treatment', fromMode: 'project_required', acceptedTypes: ['termite_treatment'], toType: 'termite_treatment', category: 'termite' },
  { key: 'termite_pretreatment', fromMode: 'project_required', acceptedTypes: ['termite_treatment'], toType: 'termite_treatment', category: 'termite' },
  { key: 'termite_trenching', fromMode: 'special_project', acceptedTypes: ['termite_treatment'], toType: 'termite_treatment', category: 'termite' },
  { key: 'termite_liquid', fromMode: 'special_project', acceptedTypes: ['termite_treatment'], toType: 'termite_treatment', category: 'termite' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[termite-cutover] service_completion_profiles table absent — skipping');
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
        console.warn(`[termite-cutover] ${target.key}: no services row and no profile in this environment — skipping`);
        continue;
      }
      // Follow-up policy rides the catalog row (straggler Codex r2): a
      // healed profile hard-coded to 'none' would silently drop an
      // included-follow-up CTA/booking gate.
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
      console.log(`[termite-cutover] ${target.key}: profile inserted → service_report/${target.toType}/auto_send (followup ${followupPolicy}${followupDays ? `/${followupDays}d` : ''})`);
      continue;
    }
    if (!row.active) {
      console.warn(`[termite-cutover] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode === 'service_report' && row.project_type === target.toType) {
      // Mode + pointer already at target — heal drifted delivery posture,
      // but never lift a 'disabled' kill switch.
      if (row.delivery_mode === 'auto_send') {
        console.log(`[termite-cutover] ${target.key}: already at target — no-op`);
      } else if (row.delivery_mode === 'internal_only') {
        await knex('service_completion_profiles')
          .where({ service_key: target.key })
          .update({
            delivery_mode: 'auto_send',
            notes: withMarker(row.notes, `updated:service_report:${row.project_type}:internal_only`),
            updated_at: knex.fn.now(),
          });
        console.log(`[termite-cutover] ${target.key}: pointer already at target, delivery internal_only → auto_send (prior recorded)`);
      } else {
        console.warn(`[termite-cutover] ${target.key}: delivery_mode='${row.delivery_mode || 'NULL'}' — skipping (kill switches stay fail-closed)`);
      }
      continue;
    }
    if (row.completion_mode !== target.fromMode || !target.acceptedTypes.includes(row.project_type)) {
      console.warn(`[termite-cutover] ${target.key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (cutover never clobbers drifted pointers)`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    // A pre-existing 'disabled' kill switch survives the mode/pointer flip
    // (straggler Codex r2) — after cutover the typed path DOES consult
    // delivery_mode, so overwriting it would re-enable customer sends
    // someone turned off.
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
    console.log(`[termite-cutover] ${target.key}: ${prior} → service_report/${target.toType}/${targetDelivery} (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', CUTOVERS.map((c) => c.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[termite_cutover_action=([^\]]*)\]/);
    if (!match) continue;
    if (match[1] === 'inserted') {
      await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
      console.log(`[termite-cutover:down] ${row.service_key}: healed insert removed`);
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
    console.log(`[termite-cutover:down] ${row.service_key}: restored ${mode || 'NULL'}/${type || 'NULL'}/${delivery || 'NULL'}`);
  }
};

// Exported for tests/termite-typed-cutover-parity.test.js — the parity
// contract pins these targets to the exact forms the Jobs flow used.
// Knex only invokes up/down; the extra export is inert at migration time.
exports.CUTOVERS = CUTOVERS;
