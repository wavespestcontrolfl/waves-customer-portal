// Two sweeps were reading whole tables once per row (owner 2026-11-04, Railway bill:
// production Postgres CPU rose from ~0.05 to ~0.65 vCPU between Oct 4 and Nov 4).
// Neither index changes a query or a result; each lets the planner answer a lookup
// the sweep already makes by index instead of by a full scan.
//
// 1. customers_live_email_key_idx: the access-code email pass (every 5 minutes)
//    proves each email in its window already read by recomputing EMAIL_HASH_SQL,
//    whose owner resolver (emailOwnerSql in services/access-code-capture.js) asks
//    customers twice per email by lower(btrim(coalesce(email, ''))) among live rows.
//    With no index that was two full customers scans per email: 8,733 emails, 55 s
//    a run on 11-04. emailOwnerId's JS read uses the same expression. The expression
//    and the deleted_at predicate must stay byte-for-byte what those queries say.
// 2. call_log_id_text_idx: the missed-call bell retire pass (every 2 minutes) joins
//    open bells to their call by call_log.id::text = notifications.metadata->'payload'
//    ->>'callLogId'. Nothing indexed id::text, so the planner ran the called-back
//    EXISTS over every call_log row before the join (3,841 rows, 30 s a run) instead
//    of over the ~13 calls behind open bells.
// Both tables are small, so a plain CREATE INDEX holds its lock for milliseconds.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customers')) {
    await knex.raw("CREATE INDEX IF NOT EXISTS customers_live_email_key_idx ON customers ((lower(btrim(coalesce(email, ''))))) WHERE deleted_at IS NULL");
  }
  if (await knex.schema.hasTable('call_log')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS call_log_id_text_idx ON call_log ((id::text))');
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS call_log_id_text_idx');
  await knex.raw('DROP INDEX IF EXISTS customers_live_email_key_idx');
};
