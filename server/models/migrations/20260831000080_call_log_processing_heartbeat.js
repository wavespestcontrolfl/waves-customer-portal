/**
 * Add call_log.processing_heartbeat_at — liveness signal for the call
 * recording processor's claim.
 *
 * Background — the stale-claim reclaim predicates could only reason from
 * processing_started_at, i.e. "started long ago", which conflates a wedged
 * pass (crashed or killed mid-flight, 2026-08-31 incident) with a healthy
 * pass working through a long transcription. The owning pass now bumps this
 * column on a timer while it runs (token-fenced, so a reclaimed pass's
 * bumps match 0 rows); "stale" becomes "stopped beating", which lets the
 * human force-reclaim act in minutes without ever stealing a live claim.
 *
 * processing_started_at keeps its documented DURABLE semantics untouched —
 * it records when the LAST pass began and bounds the bridge-ambiguity
 * phone-snapshot capture; only the reclaim predicates read the heartbeat.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'processing_heartbeat_at')) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.timestamp('processing_heartbeat_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'processing_heartbeat_at'))) return;
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('processing_heartbeat_at');
  });
};
