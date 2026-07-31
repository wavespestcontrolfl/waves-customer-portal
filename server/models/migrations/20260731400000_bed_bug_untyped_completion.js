/**
 * Untype the bed_bug_treatment completion (owner directive 2026-07-31,
 * same consolidation as the one_time_pest_treatment family untype in
 * 20260730400000): the typed "Service findings" closeout (rooms treated /
 * evidence level + chips / treatment method / work chips / customer prep /
 * activity scale / next-step chips) takes too long in the field. Bed bug
 * visits render the same basic completion form the recurring pest services
 * use — notes + free-text observations/recommendations + AI photo analysis
 * + products + activity rating.
 *
 *   bed_bug_treatment  service_report / bed_bug → service_report / null
 *
 * What survives untyping (all profile-keyed, form-independent):
 *  - one_time billing: the completion mints the visit invoice from the
 *    profile's billing_type (20260730400000 lane, commit 7);
 *  - the 14-day follow-up ALERT: followup_policy='alert' /
 *    default_followup_days=14 stay on the row — the completion route now
 *    derives the obligation from the profile for untyped alert-policy
 *    completions (same PR as this migration);
 *  - pest-pressure exclusion (one_time billing is excluded
 *    form-independently);
 *  - AI photo analysis + banned-copy sweep on the untyped path.
 * Already-completed typed bed-bug reports keep their frozen
 * typedReportSnapshot and render unchanged; this only changes what NEW
 * completions collect. The cockroach/knockdown/wildlife/rodent typed flows
 * are untouched.
 *
 * Self-healing (20260730400000 pattern — env catalogs are admin-mutable,
 * no fixed-count assertions): row absent / inactive / wrong mode / wrong
 * pointer → loud skip, never clobber; already null → no-op.
 *
 * ROLLBACK FIDELITY: up() stamps [bed_bug_untype_action=untyped:<prior>]
 * into the row's notes; down() restores exactly those rows and strips the
 * marker.
 */

const MARKER_RE = / ?\[bed_bug_untype_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[bed_bug_untype_action=${action}]`;
}

const UNTYPE_KEY = 'bed_bug_treatment';
const EXPECTED_TYPE = 'bed_bug';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  const row = await knex('service_completion_profiles')
    .where({ service_key: UNTYPE_KEY })
    .first();
  if (!row) {
    console.log(`[bed-bug-untype] ${UNTYPE_KEY}: no profile row — skip (fallback is already untyped)`);
    return;
  }
  if (row.active === false) {
    console.log(`[bed-bug-untype] ${UNTYPE_KEY}: profile inactive — skip`);
    return;
  }
  if (row.completion_mode !== 'service_report') {
    console.log(`[bed-bug-untype] ${UNTYPE_KEY}: mode ${row.completion_mode} (expected service_report) — skip`);
    return;
  }
  if (row.project_type == null) {
    console.log(`[bed-bug-untype] ${UNTYPE_KEY}: already untyped — no-op`);
    return;
  }
  if (row.project_type !== EXPECTED_TYPE) {
    console.log(`[bed-bug-untype] ${UNTYPE_KEY}: pointer ${row.project_type} (expected ${EXPECTED_TYPE}) — admin drift, skip`);
    return;
  }
  await knex('service_completion_profiles')
    .where({ service_key: UNTYPE_KEY })
    .update({
      project_type: null,
      notes: withMarker(row.notes, `untyped:${row.project_type}`),
      updated_at: new Date(),
    });
  console.log(`[bed-bug-untype] ${UNTYPE_KEY}: service_report/${EXPECTED_TYPE} → service_report/null`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  const rows = await knex('service_completion_profiles')
    .where({ service_key: UNTYPE_KEY })
    .where('notes', 'like', '%[bed_bug_untype_action=%');
  for (const row of rows) {
    const match = String(row.notes || '').match(/\[bed_bug_untype_action=untyped:([^\]]+)\]/);
    if (!match) continue;
    await knex('service_completion_profiles')
      .where({ service_key: row.service_key })
      .update({
        project_type: match[1],
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: new Date(),
      });
    console.log(`[bed-bug-untype:down] ${row.service_key}: restored service_report/${match[1]}`);
  }
};
