/**
 * Session-turn lookup index (agent-control S2d).
 *
 * The session recorder writes one row_kind='session_turn' row per recorded
 * turn beside the cumulative row_kind='session' row (llm-dispatch-metrics
 * upsertSessionRow) and, before deciding whether a record carries a new
 * failure, reads the LAST turn row of that session:
 *   WHERE provider_ref = ? AND row_kind = 'session_turn' ORDER BY id DESC
 * The existing llm_dispatch_log_session_ref_uidx is partial on
 * row_kind = 'session', so that read had no index. Additive, IF NOT EXISTS.
 */

const TABLE = 'llm_dispatch_log';
const INDEX = 'llm_dispatch_log_session_turn_ref_idx';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (provider_ref, id) WHERE row_kind = 'session_turn'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
