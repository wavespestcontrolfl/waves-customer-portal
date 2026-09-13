// Supporting indexes for no-show-detector.js's loadPromiseEvents, which the
// sweep re-runs every 5 minutes per candidate/alert/notice once
// GATE_NOSHOW_DETECTOR is on. Separate file from 20260911000020 because that
// migration had already run on the PR preview database (knex tracks by
// filename; editing a ran file is a silent no-op).
exports.up = async function up(knex) {
  // sms_log is joined ON twilio_sid and had no index on that column — a
  // sequential scan per join. Partial (twilio_sid IS NOT NULL): a send that
  // never got a provider SID back is never a join target. Plain index, not
  // CONCURRENTLY: migrations run inside a transaction pre-deploy (same as
  // call_log_metadata_lead_id_index / call_log_callback_linkage_indexes).
  await knex.raw('CREATE INDEX IF NOT EXISTS sms_log_twilio_sid_idx ON sms_log (twilio_sid) WHERE twilio_sid IS NOT NULL');
  // The customer_interactions email-evidence read filters
  // metadata->>'scheduled_service_id' = ANY(visitIds) with no supporting
  // index — a plain expression index, partial on the one interaction_type
  // this read scopes to.
  await knex.raw("CREATE INDEX IF NOT EXISTS customer_interactions_email_scheduled_service_idx ON customer_interactions ((metadata->>'scheduled_service_id')) WHERE interaction_type = 'email_outbound'");
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_interactions_email_scheduled_service_idx');
  await knex.raw('DROP INDEX IF EXISTS sms_log_twilio_sid_idx');
};
