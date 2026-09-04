/**
 * Session last activity (agent-control S2d) — when a row_kind='session'
 * ledger row last moved.
 *
 * A session row is ONE row per Managed Agents session, re-recorded after
 * every turn with cumulative usage (migration 000010's upsert): `created_at`
 * stays the first write and `latency_ms` is the longest single turn, so
 * neither says when the session was last active — and the customer
 * assistant reuses one session across turns for days. The hub read windows
 * session rows on this column (calls stay on created_at). Nullable and
 * additive; backfilled to created_at for existing session rows, which is
 * the best the old rows can say. Partial index for the session-window scan.
 */

const TABLE = 'llm_dispatch_log';
const COLUMN = 'last_activity_at';
const INDEX = 'llm_dispatch_log_session_activity_idx';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp(COLUMN, { useTz: true }); });
    await knex(TABLE).where('row_kind', 'session').whereNull(COLUMN).update({ [COLUMN]: knex.raw('created_at') });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (lane_id, ${COLUMN}) WHERE row_kind = 'session'`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};
