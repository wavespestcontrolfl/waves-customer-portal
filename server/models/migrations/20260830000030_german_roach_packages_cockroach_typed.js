/**
 * German roach packages → cockroach typed form (owner ruling 2026-08-29,
 * cockroach report V2 lane).
 *
 * `german_roach` (severity-priced cleanout) and `german_roach_initial`
 * (3-visit program) were reactivated 2026-08-09 on the GENERIC one-time
 * form (ONE_TIME_GENERIC_BY_DESIGN) because the typed pest form had been
 * retired. The owner's ruling for the cockroach treatment-program report is
 * that every one-time roach job feeds it — and the report composes from the
 * `cockroach` typed fields (species, activity level, where, evidence,
 * conducive conditions, work completed, customer prep). Point both
 * profiles at that form.
 *
 * Scope: project_type ONLY. completion_mode stays service_report; the
 * follow-up policy is untouched ('none' — these programs are SOLD as a
 * package with the visits booked together; typedFollowupVerdict only
 * overrides a REQUIRED suggestion, so a 'none' policy mints nothing —
 * the unbounded-$0-visit concern from 20260809000000 does not apply).
 *
 * ROLLBACK FIDELITY: up() stamps what it changed into the row's notes;
 * down() restores ONLY rows carrying that marker. Environments without the
 * rows loud-skip.
 */

const KEYS = ['german_roach', 'german_roach_initial'];
const MARKER_RE = / ?\[german_roach_typed_action=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[german_roach_typed_action=${action}]`;
}

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) throw new Error('service_completion_profiles table missing — German roach typed repoint cannot run');

  for (const serviceKey of KEYS) {
    const row = await knex('service_completion_profiles')
      .where({ service_key: serviceKey })
      .first('service_key', 'project_type', 'completion_mode', 'notes');
    if (!row) {
      console.log(`[migration] ${serviceKey} profile not found — skipping (environment never seeded it)`);
      continue;
    }
    if (row.project_type === 'cockroach') {
      console.log(`[migration] ${serviceKey} already points at cockroach — skipping`);
      continue;
    }
    await knex('service_completion_profiles')
      .where({ service_key: serviceKey })
      .update({
        project_type: 'cockroach',
        notes: withMarker(row.notes, `updated_from=${row.project_type || 'null'}`),
        updated_at: knex.fn.now(),
      });
    console.log(`[migration] ${serviceKey} project_type: ${row.project_type || 'null'} → cockroach`);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  for (const serviceKey of KEYS) {
    const row = await knex('service_completion_profiles')
      .where({ service_key: serviceKey })
      .first('service_key', 'project_type', 'notes');
    if (!row) continue;
    const marker = String(row.notes || '').match(/\[german_roach_typed_action=updated_from=([^\]]*)\]/);
    if (!marker) {
      console.log(`[migration] ${serviceKey} carries no repoint marker — leaving project_type as-is`);
      continue;
    }
    const previous = marker[1] === 'null' ? null : marker[1];
    await knex('service_completion_profiles')
      .where({ service_key: serviceKey })
      .update({
        project_type: previous,
        notes: String(row.notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
    console.log(`[migration] ${serviceKey} project_type restored → ${previous || 'null'}`);
  }
};
