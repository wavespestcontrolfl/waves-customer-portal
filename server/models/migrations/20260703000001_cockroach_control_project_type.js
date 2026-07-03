/**
 * Cockroach Control Service → cockroach project form (owner report 2026-07-03).
 *
 * The cockroach_control completion profile pointed project_required
 * completions at the generic one_time_pest_treatment project form (free-text
 * textareas), so a visit "listed as a cockroach control service" pulled the
 * wrong report. Point it at the dedicated `cockroach` project type — the
 * tap-to-fill form with species, activity level/locations, evidence,
 * conducive conditions, work completed, and customer-prep checklists.
 *
 * Scope: project_type ONLY. completion_mode stays project_required (so the
 * `cockroach` type stays creatable — appointmentManagedProjectTypes only
 * retires types that fully cut over to service_report mode) and the
 * follow-up policy is untouched. The two knockdown keys have their own typed
 * profiles (20260612000011) and are not affected.
 *
 * ROLLBACK FIDELITY: up() stamps what it changed into the row's notes;
 * down() restores ONLY a row carrying that marker. Environments without the
 * profile row loud-skip.
 */

const MARKER_RE = / ?\[cockroach_project_type_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[cockroach_project_type_action=${action}]`;
}

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — cockroach project-type fix cannot run');

  const row = await knex('service_completion_profiles')
    .where({ service_key: 'cockroach_control' })
    .first('service_key', 'project_type', 'notes');
  if (!row) {
    console.log('[migration] cockroach_control profile not found — skipping (environment never seeded it)');
    return;
  }
  if (row.project_type === 'cockroach') {
    console.log('[migration] cockroach_control already points at cockroach — skipping');
    return;
  }

  await knex('service_completion_profiles')
    .where({ service_key: 'cockroach_control' })
    .update({
      project_type: 'cockroach',
      notes: withMarker(row.notes, `updated_from=${row.project_type || 'null'}`),
      updated_at: knex.fn.now(),
    });
  console.log(`[migration] cockroach_control project_type: ${row.project_type} → cockroach`);
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const row = await knex('service_completion_profiles')
    .where({ service_key: 'cockroach_control' })
    .first('service_key', 'project_type', 'notes');
  const marker = String(row?.notes || '').match(/\[cockroach_project_type_action=updated_from=([^\]]*)\]/);
  // Only unwind what up() did — an untouched or hand-edited row stays put.
  if (!row || !marker) return;

  await knex('service_completion_profiles')
    .where({ service_key: 'cockroach_control' })
    .update({
      project_type: marker[1] === 'null' ? null : marker[1],
      notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
      updated_at: knex.fn.now(),
    });
};
