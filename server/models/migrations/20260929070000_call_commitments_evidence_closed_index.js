// Promises close on proof (PROMISE_EVIDENCE_CLOSE): the watchdog's 15-minute
// lapse scan reads the promises the portal closed on its own by the close
// time stored on the proof (fulfillment.closed_at). Partial on exactly that
// predicate so it never scans the ledger. closed_at is always a JS
// toISOString() value (UTC, 'Z', milliseconds), so its text order is time
// order and needs no cast. Plain index, not CONCURRENTLY: migrations run
// inside a transaction pre-deploy (same as call_commitments_slot_kept_idx).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS call_commitments_evidence_closed_idx ON call_commitments ((fulfillment ->> 'closed_at')) WHERE human_state IS NULL AND (fulfillment ->> 'closed_by') = 'promise_evidence'",
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  await knex.raw('DROP INDEX IF EXISTS call_commitments_evidence_closed_idx');
};
