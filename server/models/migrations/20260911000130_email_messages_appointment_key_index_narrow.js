// Supersedes the index 20260911000110 created (that file has already run on
// the PR preview database, so editing it would be a silent no-op — .claude/
// skills/waves-db/SKILL.md §4). Same expression, one event type narrower:
// there is no `appointment.rescheduled` sender, so listing it only widened
// what counts as promise evidence and the index footprint for a workflow that
// does not exist (codex P2, PR #4403 round 13).
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_appointment_visit_idx');
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_appointment_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 2)))
    WHERE split_part(idempotency_key, ':', 1) IN
      ('appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h')`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS email_messages_appointment_visit_idx');
  await knex.raw(`CREATE INDEX IF NOT EXISTS email_messages_appointment_visit_idx
    ON email_messages ((split_part(idempotency_key, ':', 2)))
    WHERE split_part(idempotency_key, ':', 1) IN
      ('appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h', 'appointment.rescheduled')`);
};
