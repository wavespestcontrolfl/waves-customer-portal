// Puts appointment.rescheduled back in the partial index no-show-detector.js's
// email recovery and recall read (email_messages_appointment_visit_idx).
// 20260911000130 narrowed it because no appointment.rescheduled sender existed;
// GATE_MOVE_NOTICE_EMAIL adds one (the email version of a reschedule text that
// reached nobody), and the detector's APPOINTMENT_EMAIL_EVENTS lists it again.
// A query whose event list is wider than the index predicate cannot use the
// index, so without this the five-minute sweep would scan all message history.
// Same expression and predicate as 20260911000110; down() restores 130's.
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_appointment_visit_idx');
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_appointment_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 2)))
    WHERE split_part(idempotency_key, ':', 1) IN
      ('appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h', 'appointment.rescheduled')`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_appointment_visit_idx');
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_appointment_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 2)))
    WHERE split_part(idempotency_key, ':', 1) IN
      ('appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h')`);
};
