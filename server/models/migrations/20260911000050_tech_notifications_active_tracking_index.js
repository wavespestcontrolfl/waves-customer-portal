// sweep()'s tech-notice reconcile pass reads every undismissed
// follow_through_tracking row every five minutes, constrained only by type
// and dismissed_at. tech_notifications' only index starts with technician_id
// (20260414000029_geofence_timers.js), which cannot serve that predicate, so
// as geofence, timer, text and visit-notice history accumulates this becomes
// a full-table scan to find a usually tiny active set (codex P2, PR #4403
// round 5). Partial on the two constants, so the index stays about as small
// as the active set it serves.
//
// Its own file rather than an edit to 20260911000040, for the same reason
// that one is separate from 20260911000030: knex tracks migrations by
// filename, so editing a file the PR preview database has already run is a
// silent no-op.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS tech_notifications_active_tracking_idx
    ON tech_notifications (type) WHERE type = 'follow_through_tracking' AND dismissed_at IS NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS tech_notifications_active_tracking_idx');
};
