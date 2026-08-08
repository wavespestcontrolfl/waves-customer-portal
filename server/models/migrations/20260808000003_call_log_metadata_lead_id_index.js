// The phone-less reuse linkage stamps call_log.metadata.lead_id (PR #3275),
// and four consumers now filter/join on metadata->>'lead_id' (admin lead
// card, estimator loadLeadForCall, agent-estimate context, google-call
// bridge) — without an index every expanded lead card sequentially scans
// call history. Partial expression index: only stamped rows (a small
// minority — the stamp exists only for phone-less reused-lead calls) are
// indexed, so the build and the index stay tiny. Plain index (not
// CONCURRENTLY: migrations run inside a transaction pre-deploy, same
// reasoning as the newsletter_send_deliveries index).
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('call_log');
  if (!has) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_metadata_lead_id_index ON call_log ((metadata->>'lead_id')) WHERE metadata->>'lead_id' IS NOT NULL",
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('call_log');
  if (!has) return;
  await knex.raw('DROP INDEX IF EXISTS call_log_metadata_lead_id_index');
};
