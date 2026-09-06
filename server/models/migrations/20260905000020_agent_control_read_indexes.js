/**
 * Read indexes for the agent-control run index (S3, Codex r4).
 *
 * The Runs list projects legacy ledgers through correlated lookups the
 * existing indexes do not serve:
 *   - message-drafts → its newest linked decision
 *     (agent_decisions WHERE entity_type = 'message_draft' AND entity_id = draft ORDER BY created_at DESC)
 *   - managed-sessions → its turns
 *     (llm_dispatch_log WHERE row_kind = 'session_turn' AND provider_ref = session: count, max(created_at))
 * A first page scans up to 2 000 rows per source, so each lookup must be
 * an index probe, not a table scan. Additive, IF NOT EXISTS.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('agent_decisions')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS agent_decisions_entity_idx ON agent_decisions (entity_type, entity_id, created_at DESC)');
  }
  if (await knex.schema.hasTable('llm_dispatch_log')) {
    await knex.raw("CREATE INDEX IF NOT EXISTS llm_dispatch_log_session_turn_ref_idx ON llm_dispatch_log (provider_ref, created_at) WHERE row_kind = 'session_turn'");
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS agent_decisions_entity_idx');
  await knex.raw('DROP INDEX IF EXISTS llm_dispatch_log_session_turn_ref_idx');
};
