exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('tech_notifications', 'dedupe_key'))) {
    await knex.schema.alterTable('tech_notifications', (t) => { t.string('dedupe_key', 160).nullable().unique(); });
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS messaging_audit_appointment_sent_idx ON messaging_audit_log (appointment_id, sent_at DESC) WHERE sent_at IS NOT NULL');
  await knex.raw("CREATE INDEX IF NOT EXISTS audit_visit_promised_window_idx ON audit_log (resource_id, created_at DESC) WHERE action = 'visit_window_promised'");
  // no-show-detector.js's loadPromiseEvents joins sms_log ON twilio_sid for
  // every candidate/alert/notice the sweep re-evaluates (every 5 minutes),
  // and sms_log had no index on that column — a sequential scan per join.
  // Partial (twilio_sid IS NOT NULL): a send that never got a provider SID
  // back is never a join target, so it's never worth indexing. Plain index,
  // not CONCURRENTLY: migrations run inside a transaction pre-deploy (same
  // as call_log_metadata_lead_id_index / call_log_callback_linkage_indexes).
  await knex.raw('CREATE INDEX IF NOT EXISTS sms_log_twilio_sid_idx ON sms_log (twilio_sid) WHERE twilio_sid IS NOT NULL');
  // Same sweep, the customer_interactions email-evidence read filters
  // metadata->>'scheduled_service_id' = ANY(visitIds) with no supporting
  // index — a plain expression index (analogous to the sms_log one above,
  // not a GIN/jsonb-path index, so no broader indexing-strategy call is
  // needed here), partial on the one interaction_type this read scopes to.
  await knex.raw("CREATE INDEX IF NOT EXISTS customer_interactions_email_scheduled_service_idx ON customer_interactions ((metadata->>'scheduled_service_id')) WHERE interaction_type = 'email_outbound'");
};

// Gate rollback preserves notification history and communication evidence.
// Index-only additions (P2-2, pre-push audit on bb2ff6752) are dropped
// explicitly rather than left for down() to no-op silently.
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_email_scheduled_service_idx');
  await knex.raw('DROP INDEX IF EXISTS sms_log_twilio_sid_idx');
};
