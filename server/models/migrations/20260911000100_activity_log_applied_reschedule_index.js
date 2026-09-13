// no-show-detector.js derives the promise an APPLIED call reschedule made
// from the activity_log row call-reschedule-apply.js writes in the same
// transaction as the move, looked up by the visit id in its metadata. The
// table indexes only action and created_at, so without this the five-minute
// sweep scans every activity row of that action. Partial + expression, so the
// index holds exactly the rows this read can match.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS activity_log_applied_reschedule_visit_idx
    ON activity_log ((metadata->>'scheduled_service_id'))
    WHERE action = 'call_reschedule_applied'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS activity_log_applied_reschedule_visit_idx');
};
