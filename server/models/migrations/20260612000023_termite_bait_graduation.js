/**
 * Termite bait station graduation: internal_only → auto_send for the six
 * termite bait keys, on the owner's FS 482.226 / FAC 5E-14 compliance
 * signoff (2026-06-12). The rodent bait pair (rodent_bait_quarterly,
 * rodent_bait_setup) is NOT touched — it graduates with the rodent-family
 * shadow review.
 *
 * Self-healing/per-key against live state (the #1617 lesson: env catalogs
 * are admin-mutable; never assert replay-derived counts):
 *  - profile absent → loud skip (nothing to graduate in this environment)
 *  - profile inactive → loud skip (runtime ignores inactive rows)
 *  - not the typed termite profile (mode/type mismatch) → loud skip —
 *    graduation must never repoint a profile, only flip delivery
 *  - already auto_send → no-op
 *
 * Completed visits keep their FROZEN typedReportDelivery posture
 * (structured_notes) — graduation never retro-publishes stored shadow
 * reports; only completions after this runs deliver to customers.
 *
 * ROLLBACK FIDELITY: up() stamps [termite_graduation_action=updated:<prior>]
 * into the row's notes and down() restores ONLY those rows to their prior
 * delivery_mode, stripping the marker.
 */

const MARKER_RE = / ?\[termite_graduation_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[termite_graduation_action=${action}]`;
}

const TERMITE_BAIT_KEYS = [
  'termite_bait',
  'termite_active_annual',
  'termite_active_bait_quarterly',
  'termite_monitoring',
  'termite_cartridge_replacement',
  'termite_installation_setup',
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) {
    console.warn('[termite-graduation] service_completion_profiles table absent — skipping');
    return;
  }
  for (const key of TERMITE_BAIT_KEYS) {
    const row = await knex('service_completion_profiles').where({ service_key: key }).first();
    if (!row) {
      console.warn(`[termite-graduation] ${key}: profile row ABSENT in this environment — skipping`);
      continue;
    }
    if (!row.active) {
      console.warn(`[termite-graduation] ${key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (row.completion_mode !== 'service_report' || row.project_type !== 'termite_bait_station') {
      console.warn(`[termite-graduation] ${key}: UNEXPECTED state ${row.completion_mode || '-'}/${row.project_type || '-'} — skipping (graduation only flips delivery on the typed termite profile)`);
      continue;
    }
    if (row.delivery_mode === 'auto_send') {
      console.log(`[termite-graduation] ${key}: already auto_send — no-op`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: key })
      .update({
        delivery_mode: 'auto_send',
        notes: withMarker(row.notes, `updated:${row.delivery_mode || '-'}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[termite-graduation] ${key}: ${row.delivery_mode || '-'} → auto_send (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;
  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', TERMITE_BAIT_KEYS)
    .select('service_key', 'notes', 'delivery_mode');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[termite_graduation_action=updated:([^\]]*)\]/);
    if (!match) continue;
    const prior = match[1] === '-' ? null : match[1];
    await knex('service_completion_profiles')
      .where({ service_key: row.service_key })
      .update({
        delivery_mode: prior,
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
    console.log(`[termite-graduation:down] ${row.service_key}: restored delivery_mode=${prior || 'NULL'}`);
  }
};
