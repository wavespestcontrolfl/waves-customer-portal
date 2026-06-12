/**
 * Flea typed cutover (owner spec 2026-06-12, Phase 2 §5, Priority 4).
 *
 * Flips flea_tick from the project-required flow to the typed flea
 * service-report (tap-to-fill form per the owner vocabularies, with the
 * required aftercare core and deterministic cooperation line).
 *
 * delivery_mode stays auto_send (the row's current posture): flea customers
 * receive reports today, and the typed report IS the stronger aftercare
 * note the owner specified. The no-op check includes delivery_mode so a
 * drifted row heals to the documented target (Codex round-1 lesson on the
 * knockdown migration).
 *
 * Self-healed pattern (20260611000012/16): update / insert / heal /
 * loud-skip. ROLLBACK FIDELITY: up() stamps prior mode:type:delivery into
 * the row's notes marker; down() restores ONLY what up() changed.
 */

const MARKER_RE = / ?\[flea_typed_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[flea_typed_action=${action}]`;
}

const TARGET = { key: 'flea_tick', projectType: 'flea' };

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — flea cutover cannot run');

  const service = await knex('services').where({ service_key: TARGET.key }).first('id', 'name', 'billing_type');
  if (!service) {
    console.warn(`[flea-typed] ${TARGET.key}: services row ABSENT in this environment — skipping profile`);
    return;
  }
  const row = await knex('service_completion_profiles').where({ service_key: TARGET.key }).first();
  if (row && !row.active) {
    console.warn(`[flea-typed] ${TARGET.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
    return;
  }
  if (!row) {
    await knex('service_completion_profiles').insert({
      service_key: TARGET.key,
      service_name_snapshot: service.name,
      category: 'pest_control',
      billing_type: service.billing_type || 'one_time',
      completion_mode: 'service_report',
      project_type: TARGET.projectType,
      delivery_mode: 'auto_send',
      creates_service_record: true,
      portal_visibility: 'customer_portal',
      portal_attach_policy: 'active_portal_customer',
      followup_policy: 'none',
      active: true,
      notes: withMarker('', 'inserted'),
    });
    console.log(`[flea-typed] ${TARGET.key}: profile inserted → service_report/flea/auto_send`);
    return;
  }
  if (
    row.completion_mode === 'service_report'
    && row.project_type === TARGET.projectType
    && row.delivery_mode === 'auto_send'
  ) {
    console.log(`[flea-typed] ${TARGET.key}: already at target — no-op`);
    return;
  }
  const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
  await knex('service_completion_profiles')
    .where({ service_key: TARGET.key })
    .update({
      completion_mode: 'service_report',
      project_type: TARGET.projectType,
      delivery_mode: 'auto_send',
      notes: withMarker(row.notes, `updated:${prior}`),
      updated_at: knex.fn.now(),
    });
  console.log(`[flea-typed] ${TARGET.key}: ${prior} → service_report/flea/auto_send (prior recorded)`);
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const row = await knex('service_completion_profiles')
    .where({ service_key: TARGET.key })
    .first('service_key', 'notes');
  if (!row) return;
  const match = String(row.notes || '').match(/\[flea_typed_action=([^\]]*)\]/);
  if (!match) return; // up() never touched this row
  const action = match[1];
  if (action === 'inserted') {
    await knex('service_completion_profiles').where({ service_key: TARGET.key }).del();
    console.log(`[flea-typed:down] ${TARGET.key}: inserted profile deleted`);
    return;
  }
  const prior = action.match(/^updated:([^:]+):([^:]+):([^:]+)$/);
  if (prior) {
    await knex('service_completion_profiles')
      .where({ service_key: TARGET.key })
      .update({
        completion_mode: prior[1] === '-' ? null : prior[1],
        project_type: prior[2] === '-' ? null : prior[2],
        delivery_mode: prior[3] === '-' ? null : prior[3],
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
    console.log(`[flea-typed:down] ${TARGET.key}: restored ${prior[1]}/${prior[2]}/${prior[3]}`);
  }
};
