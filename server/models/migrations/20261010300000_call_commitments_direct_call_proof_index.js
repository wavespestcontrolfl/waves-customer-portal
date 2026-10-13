// A callback promise kept on a direct outbound-call proof is judged again
// when that call is later reprocessed to spam (call-commitments
// listLapsedEvidenceClosedCallIds + refreshFulfillment, GATE_CALLBACK_SPAM_
// CLOSES_PARENT). The lapse scan reads those rows through this partial index
// (codex #6271 r19 P1). Same shape as 20261010280000.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_commitments_direct_call_proof_index ON call_commitments ((fulfillment->>'record_id')) WHERE status = 'fulfilled' AND fulfillment->>'record_type' = 'call_log' AND fulfillment->>'strength' = 'direct'",
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_commitments_direct_call_proof_index');
};
