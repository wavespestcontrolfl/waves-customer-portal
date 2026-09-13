// no-show-detector.js recovers an appointment email's promised window
// directly from email_messages when the customer_interactions row that
// normally carries it was never written (that insert is best-effort and the
// send still reports success). The lookup is by the visit id encoded in the
// idempotency key — `<event_type>:<scheduled_service_id>:<slot ms>:<recipient
// token>` — so index that expression, partial on the appointment event types
// this read accepts, or the five-minute sweep scans all message history.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_appointment_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 2)))
    WHERE split_part(idempotency_key, ':', 1) IN
      ('appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h', 'appointment.rescheduled')`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_appointment_visit_idx');
};
