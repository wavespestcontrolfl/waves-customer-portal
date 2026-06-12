/**
 * Tree & Shrub typed checklist cutover (owner spec 2026-06-12, Phase 2 §6).
 *
 * Points the two Tree & Shrub program keys at the new `tree_shrub` typed
 * findings flow. Both keys are already completion_mode='service_report'
 * with delivery_mode='auto_send' and NO project_type (generic reports) —
 * this adds the project_type pointer so completions render the typed
 * plant-health form and the owner-authored customer template.
 *
 * delivery_mode is intentionally NOT changed: T&S customers receive
 * auto-sent generic reports today, and the owner authored the new customer
 * copy in the spec (docs/design/specialty-phase2-owner-spec.md). Going
 * internal_only would silently stop reports customers already get.
 *
 * The legacy Tree/Shrub closeout hard-block remains for NON-typed T&S/palm
 * completions (admin-created custom service names that don't resolve to
 * these keys); typed completions enforce the ported compliance checks via
 * validateTreeShrubTypedCompliance (N/P blackout, pollinator, IRAC/FRAC,
 * product actuals, photo minimum, injection redirect).
 *
 * Per-key resolution follows the self-healed 20260611000012/16 pattern —
 * catalogs are admin-mutable, so: update / insert / heal / loud-skip.
 * ROLLBACK FIDELITY: up() stamps prior mode:type:delivery into the row's
 * notes marker; down() restores ONLY what up() changed.
 */

const MARKER_RE = / ?\[tree_shrub_typed_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[tree_shrub_typed_action=${action}]`;
}

const TARGETS = [
  { key: 'tree_shrub_program', category: 'tree_shrub', billingType: 'recurring' },
  { key: 'tree_shrub_6week', category: 'tree_shrub', billingType: 'recurring' },
];

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — tree & shrub cutover cannot run');

  for (const target of TARGETS) {
    const service = await knex('services').where({ service_key: target.key }).first('id', 'name');
    if (!service) {
      console.warn(`[tree-shrub-typed] ${target.key}: services row ABSENT in this environment — skipping profile`);
      continue;
    }
    const row = await knex('service_completion_profiles').where({ service_key: target.key }).first();
    if (row && !row.active) {
      console.warn(`[tree-shrub-typed] ${target.key}: profile row is INACTIVE — skipping (runtime ignores inactive rows)`);
      continue;
    }
    if (!row) {
      await knex('service_completion_profiles').insert({
        service_key: target.key,
        service_name_snapshot: service.name,
        category: target.category,
        billing_type: target.billingType,
        completion_mode: 'service_report',
        project_type: 'tree_shrub',
        delivery_mode: 'auto_send',
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        notes: withMarker('', 'inserted'),
      });
      console.log(`[tree-shrub-typed] ${target.key}: profile inserted → service_report/tree_shrub/auto_send`);
      continue;
    }
    if (row.completion_mode === 'service_report' && row.project_type === 'tree_shrub') {
      console.log(`[tree-shrub-typed] ${target.key}: already at target — no-op`);
      continue;
    }
    const prior = `${row.completion_mode || '-'}:${row.project_type || '-'}:${row.delivery_mode || '-'}`;
    await knex('service_completion_profiles')
      .where({ service_key: target.key })
      .update({
        completion_mode: 'service_report',
        project_type: 'tree_shrub',
        // delivery_mode intentionally untouched — see header.
        notes: withMarker(row.notes, `updated:${prior}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[tree-shrub-typed] ${target.key}: ${prior} → service_report/tree_shrub/(delivery unchanged) (prior recorded)`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const rows = await knex('service_completion_profiles')
    .whereIn('service_key', TARGETS.map((t) => t.key))
    .select('service_key', 'notes');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[tree_shrub_typed_action=([^\]]*)\]/);
    if (!match) continue; // up() never touched this row
    const action = match[1];
    if (action === 'inserted') {
      await knex('service_completion_profiles').where({ service_key: row.service_key }).del();
      console.log(`[tree-shrub-typed:down] ${row.service_key}: inserted profile deleted`);
      continue;
    }
    const prior = action.match(/^updated:([^:]+):([^:]+):([^:]+)$/);
    if (prior) {
      await knex('service_completion_profiles')
        .where({ service_key: row.service_key })
        .update({
          completion_mode: prior[1] === '-' ? null : prior[1],
          project_type: prior[2] === '-' ? null : prior[2],
          // delivery_mode was never changed by up(); prior[3] recorded for
          // audit only.
          notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
          updated_at: knex.fn.now(),
        });
      console.log(`[tree-shrub-typed:down] ${row.service_key}: restored ${prior[1]}/${prior[2]} (delivery untouched)`);
    }
  }
};
