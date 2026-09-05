/**
 * Paging key for the canonical run ledger (S3, Codex r14) — supersedes
 * 20260905000040_agent_runs_start_idx.
 *
 * The Runs list pages every source on an IMMUTABLE stamp: for agent_runs
 * that is created_at (stamped once by insertRun), not the active span
 * COALESCE(started_at, created_at) the earlier index served — started_at
 * moves on a resume / reopen, so a run could cross a page cursor and
 * repeat or vanish. The S3 migration's agent_runs_created_idx (created_at)
 * already serves the ordered scan (a backward index scan; the id tiebreak
 * only orders rows sharing one millisecond), so nothing is created here —
 * the span index is dropped. The 000040 file stays: a preview deploy may
 * have run it. IF EXISTS.
 */

exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS agent_runs_start_idx');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('agent_runs'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS agent_runs_start_idx ON agent_runs ((COALESCE(started_at, created_at)) DESC, id DESC)');
};
