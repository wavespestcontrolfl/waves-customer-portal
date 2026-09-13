// The GROUPED reminder email's idempotency key is
// `appointment.reminder_<kind>:visit:<service_visits id>:<effect>:<date>`
// (appointment-reminders.js's visitReminderEmailKey). no-show-detector.js
// recovers those promises through the stop id in segment 3 when the
// interaction row that normally carries the window was never written, so
// index that expression — partial on the grouped shape, which is the only one
// this read matches.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_grouped_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 3)))
    WHERE split_part(idempotency_key, ':', 2) = 'visit'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_grouped_visit_idx');
};
