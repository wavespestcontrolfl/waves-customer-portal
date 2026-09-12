// no-show-detector.js's candidate scan no longer trusts scheduled_date alone:
// a still-live visit that staff moved far out of the date window WITHOUT
// telling the customer is exactly what the detector exists to catch, so
// promisedVisitIds also pulls in visits the customer was told about recently
// (codex P2, PR #4403). These are the two time-ranged lookups that had no
// supporting index of their own.
exports.up = async function up(knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS messaging_audit_recent_appointment_idx
    ON messaging_audit_log (sent_at)
    WHERE appointment_id IS NOT NULL OR metadata->>'scheduled_service_id' IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS customer_interactions_email_recent_idx
    ON customer_interactions (created_at) WHERE interaction_type = 'email_outbound'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_email_recent_idx');
  await knex.raw('DROP INDEX IF EXISTS messaging_audit_recent_appointment_idx');
};
