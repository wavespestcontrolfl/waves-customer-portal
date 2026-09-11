exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('tech_notifications', 'dedupe_key'))) {
    await knex.schema.alterTable('tech_notifications', (t) => { t.string('dedupe_key', 160).nullable().unique(); });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS messaging_audit_appointment_sent_idx ON messaging_audit_log (appointment_id, sent_at DESC) WHERE sent_at IS NOT NULL');
  await knex.raw("CREATE INDEX IF NOT EXISTS audit_visit_promised_window_idx ON audit_log (resource_id, created_at DESC) WHERE action = 'visit_window_promised'");
};

// Gate rollback preserves notification history and communication evidence.
exports.down = async function down() {};
