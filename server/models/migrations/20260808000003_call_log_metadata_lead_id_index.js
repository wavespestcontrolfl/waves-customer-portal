// The phone-less reuse linkage stamps call_log.metadata.lead_id, and the
// rejection path's successor-snapshot lookup in clearStampAndRestoreLead
// scans for sibling calls by metadata->>'lead_id' — without an index that is
// a sequential scan of call history on every stamp clear. The consumers that
// READ the stamp (admin lead card, agent-estimate context, google-call
// bridge, estimator grounding) land in follow-up PRs and inherit this index.
// Partial expression index: only stamped rows are indexed — the stamp exists
// solely for phone-less reused-lead calls, a small minority — so the build
// and the index stay tiny. Plain index (not CONCURRENTLY: migrations run
// inside a transaction pre-deploy, same reasoning as the
// newsletter_send_deliveries index).
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
