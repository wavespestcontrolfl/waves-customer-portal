/**
 * Billing-rider report suppression (owner ruling 2026-07-12, recorded in
 * the ratified universal one-time services plan): termite_renewal and the
 * three termite_bond_* keys get scheduled as services but are billing
 * riders — invoice line + a reference in the MAIN service's post-service
 * report only. They must not run their own customer report lane.
 *
 * Mechanism (Codex r2): completion_mode → 'internal_only' — the
 * consultation posture (Waves Assessment pattern) is the ONLY suppression
 * resolveCompletionDeliveryPosture honors for non-typed completions
 * (delivery_mode is ignored on generic profiles): no public report token,
 * completion SMS/email suppressed, the service_records audit row still
 * written, billing/invoicing untouched. delivery_mode is also parked at
 * 'disabled' for defense in depth.
 *
 * Enforced by the completion-lane registry/audit shipped alongside
 * (billing_rider_report_lane_active flags any other posture). The
 * reminder-SMS exclusion and the report/invoice reference lines are
 * separate follow-up lanes recorded in the plan.
 *
 * Self-healing per-key: absent/inactive → loud skip; non-generic or typed
 * pointer → loud skip (admin drift is never clobbered); already
 * internal_only → no-op. Marker-based rollback restores the exact prior
 * mode + delivery.
 */

const MARKER_RE = / ?\[billing_rider_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[billing_rider_action=${action}]`;
}

const RIDER_KEYS = [
  'termite_renewal',
  'termite_bond_1yr',
  'termite_bond_5yr',
  'termite_bond_10yr',
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[billing-rider] service_completion_profiles table absent — skipping');
    return;
  }
  for (const key of RIDER_KEYS) {
    const row = await knex('service_completion_profiles').where({ service_key: key }).first();
    if (!row) {
      console.warn(`[billing-rider] ${key}: profile row ABSENT in this environment — skipping`);
      continue;
    }
    if (!row.active) {
      console.warn(`[billing-rider] ${key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode === 'internal_only' && !row.project_type) {
      console.log(`[billing-rider] ${key}: already internal_only — no-op`);
      continue;
    }
    if (row.completion_mode !== 'service_report' || row.project_type) {
      console.warn(`[billing-rider] ${key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (suppression only applies to the generic recurring profile)`);
      continue;
    }
    const prior = `${row.completion_mode}:${row.delivery_mode || '-'}`;
    await knex('service_completion_profiles')
      .where({ service_key: key })
      .update({
        completion_mode: 'internal_only',
        delivery_mode: 'disabled',
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[billing-rider] ${key}: ${prior} → internal_only/disabled (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', RIDER_KEYS)
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[billing_rider_action=updated:([^\]]*)\]/);
    if (!match) continue;
    const [mode, delivery] = match[1].split(':').map((v) => (v === '-' ? null : v));
    await knex('service_completion_profiles')
      .where({ service_key: row.service_key })
      .update({
        completion_mode: mode,
        delivery_mode: delivery,
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
    console.log(`[billing-rider:down] ${row.service_key}: restored ${mode || 'NULL'}/${delivery || 'NULL'}`);
  }
};
