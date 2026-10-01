// Codex pre-push r5 P2 on PR #5012 (outbound return-message gate,
// GATE_CALL_OUTBOUND_RETURN_MESSAGES): server/services/outbound-call-reason.js's
// hasPriorContact runs three UNBOUNDED phone probes (existsQualifyingInboundCall
// over call_log, existsQualifyingInboundText over sms_log, anyLeadRecord over
// leads) — no row cap, so each is a full scan unless the planner can match
// the exact expression the query filters on:
//   right(regexp_replace(<col>, '\D', '', 'g'), 10) = ?
// leads.phone already carries a plain btree index, which cannot serve this
// expression — only a matching expression index can. At today's prod scale
// (~3.2k call_log rows, ~9.9k sms_log, ~800 leads) EXPLAIN ANALYZE shows
// each unindexed probe at 5-6ms — not a live problem, this is future-
// proofing before the tables grow. Text expression MUST match the query
// character-for-character (including the escaped '\D') or the planner will
// not use the index.
exports.up = async function up(knex) {
  const hasCallLog = await knex.schema.hasTable('call_log');
  if (hasCallLog) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS call_log_from_phone_last10_index ON call_log ((right(regexp_replace(from_phone, '\\D', '', 'g'), 10)))"
    );
  }
  const hasSmsLog = await knex.schema.hasTable('sms_log');
  if (hasSmsLog) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS sms_log_from_phone_last10_index ON sms_log ((right(regexp_replace(from_phone, '\\D', '', 'g'), 10)))"
    );
  }
  const hasLeads = await knex.schema.hasTable('leads');
  if (hasLeads) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS leads_phone_last10_index ON leads ((right(regexp_replace(phone, '\\D', '', 'g'), 10)))"
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS leads_phone_last10_index');
  await knex.raw('DROP INDEX IF EXISTS sms_log_from_phone_last10_index');
  await knex.raw('DROP INDEX IF EXISTS call_log_from_phone_last10_index');
};
