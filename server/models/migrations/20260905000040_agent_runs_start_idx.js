/**
 * Paging key index for the canonical run ledger (S3, Codex r9).
 *
 * The Runs list orders and windows agent_runs on COALESCE(started_at,
 * created_at) — the run's current active span (started_at moves on a
 * reopen / resume; created_at only backs a queued row that never started).
 * The S3 migration indexes plain created_at, which that expression cannot
 * use, so the ledger would be scanned and sorted on every first page once
 * GATE_AGENT_RUNS has history. Additive, IF NOT EXISTS.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('agent_runs'))) return;
  await knex.raw('CREATE INDEX IF NOT EXISTS agent_runs_start_idx ON agent_runs ((COALESCE(started_at, created_at)) DESC, id DESC)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS agent_runs_start_idx');
};
