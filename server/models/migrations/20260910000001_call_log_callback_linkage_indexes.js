// Callback attempts stamp call_log.metadata.relatedCommitmentId (card) or
// relatedCallId + callback_policy = 'card' (the Call Log action under the
// card policy). Fulfillment refresh probes call_log by those keys for every
// open callback it judges — the refreshable-verdict predicate's EXISTS and
// the card-policy linkage lookups — and the watchdog walks up to 5,000
// commitments per sweep, so without indexes every unfulfilled callback is a
// sequential scan of call history. Partial expression indexes: only stamped
// rows are indexed (a small minority of calls), matching the predicates the
// lookups use so the planner can prove the partial condition. Plain index,
// not CONCURRENTLY: migrations run inside a transaction pre-deploy (same as
// call_log_metadata_lead_id_index).
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('call_log');
  if (!has) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_metadata_related_commitment_id_index ON call_log ((metadata->>'relatedCommitmentId')) WHERE metadata->>'relatedCommitmentId' IS NOT NULL",
  );
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_log_metadata_card_related_call_id_index ON call_log ((metadata->>'relatedCallId')) WHERE metadata->>'callback_policy' = 'card'",
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('call_log');
  if (!has) return;
  await knex.raw('DROP INDEX IF EXISTS call_log_metadata_card_related_call_id_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_metadata_related_commitment_id_index');
};
