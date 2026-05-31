/**
 * Route the initial roach knockdown services to the cockroach project type.
 *
 * `pest_initial_palmetto_knockdown` and `pest_initial_german_knockdown` are
 * one-time, project-backed services, but they match the broad `/^pest_initial_/`
 * rule in the service_completion_profiles seed (20260521000005) and therefore
 * resolved to `one_time_pest_treatment`. That meant a tech completing a
 * scheduled roach service from dispatch got the generic one-time-pest form
 * instead of the cockroach-specific fields. Re-point both profiles at the
 * `cockroach` project type.
 *
 * German cockroach work always warrants a re-service, so the German profile
 * also gets `followup_policy: 'alert'` — closeout follow-up alerts are driven
 * by service_completion_profiles.followup_policy (see projectFollowupSuggestion
 * in server/services/project-completion.js), not the registry requiresFollowup
 * flag. Native/palmetto roach work is not auto-flagged for follow-up, so its
 * policy is left as-is. Idempotent.
 */

const GERMAN_SERVICE_KEY = 'pest_initial_german_knockdown';
const ROACH_SERVICE_KEYS = [
  'pest_initial_palmetto_knockdown',
  GERMAN_SERVICE_KEY,
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  await knex('service_completion_profiles')
    .whereIn('service_key', ROACH_SERVICE_KEYS)
    .update({
      project_type: 'cockroach',
      notes: 'Initial roach knockdown routed through the cockroach Project type.',
      updated_at: knex.fn.now(),
    });
  // German cockroach always needs a follow-up visit; surface the alert at closeout.
  await knex('service_completion_profiles')
    .where('service_key', GERMAN_SERVICE_KEY)
    .update({
      followup_policy: 'alert',
      notes: 'Initial German roach knockdown routed through the cockroach Project type; follow-up always recommended.',
      updated_at: knex.fn.now(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_completion_profiles'))) return;
  await knex('service_completion_profiles')
    .whereIn('service_key', ROACH_SERVICE_KEYS)
    .update({
      project_type: 'one_time_pest_treatment',
      notes: 'One-time service routed through Projects as the primary customer artifact.',
      updated_at: knex.fn.now(),
    });
  await knex('service_completion_profiles')
    .where('service_key', GERMAN_SERVICE_KEY)
    .update({
      followup_policy: 'none',
      updated_at: knex.fn.now(),
    });
};
