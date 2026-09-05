/**
 * Session-turn identity (agent-control S2d).
 *
 * The session recorder writes one row_kind='session_turn' row per turn of
 * a Managed Agents session beside the cumulative row_kind='session' row
 * (llm-dispatch-metrics upsertSessionRow). A turn is identified by
 * (session id, turn start) as a uuid v5 in step_id; this unique partial
 * index is the idempotency key every re-record of the same turn upserts
 * against (INSERT … ON CONFLICT, monotone merge), so a runner's finally
 * re-billing, a retried terminal write or a recovered usage GET can never
 * produce a second row for one turn. Additive, IF NOT EXISTS.
 */

const TABLE = 'llm_dispatch_log';
const INDEX = 'llm_dispatch_log_session_turn_uidx';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (step_id) WHERE row_kind = 'session_turn'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};
