// The Today page polls GET /api/tech/notifications/schedule-changes every
// 10 seconds: one technician's undismissed visit_* cards, newest first. The
// general index (technician_id, read, created_at — 20260414000029) cannot
// serve "dismissed_at IS NULL", so each poll would walk the technician's whole
// notification history (Codex #5783 P2). Partial on the open schedule-change
// types, keyed by technician and creation time, so it stays about the size of
// the open set it serves.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS tech_notifications_open_schedule_changes_idx
    ON tech_notifications (technician_id, created_at DESC)
    WHERE dismissed_at IS NULL
      AND type IN ('visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled')`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS tech_notifications_open_schedule_changes_idx');
};
