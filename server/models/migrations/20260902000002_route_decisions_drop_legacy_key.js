/**
 * route_decisions — CONTRACT step of the recording-keyed audit rollout.
 *
 * 20260902000001 (PR #3736) added recording_sid and the four-column unique
 * index while KEEPING the legacy UNIQUE (call_log_id, decision_version,
 * mode) so the previous release's inserts — which name that constraint as
 * their ON CONFLICT target — survived the rolling-deploy overlap. Every
 * writer since inserts ON CONFLICT DO NOTHING without a target, so nothing
 * depends on the legacy constraint by name; while it stands, a REPLACED
 * recording's decision (operator adoption, a superseding callback) is still
 * suppressed and the discarded recording's row stays newest. Dropping it is
 * what lets each recording's decision be its own immutable row.
 *
 * Merge only after the #3736 release has fully drained (no instance of the
 * prior release still running).
 */

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE route_decisions DROP CONSTRAINT IF EXISTS route_decisions_call_log_id_decision_version_mode_unique');
};

exports.down = async function down(knex) {
  // Reversible only while no call carries decisions for two recordings.
  await knex.schema.alterTable('route_decisions', (t) => {
    t.unique(['call_log_id', 'decision_version', 'mode']);
  });
};
