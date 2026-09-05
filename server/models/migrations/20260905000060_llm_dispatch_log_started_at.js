/**
 * Persisted start for session ledger rows (S3, Codex r12).
 *
 * recordSessionUsage captures a turn's latency BEFORE its usage GET and
 * inserts the row after it, so `created_at − latency_ms` — the start the
 * runs read derived — drifted late by the whole fetch (up to its 15 s
 * timeout), and paged rows moved with it. The recorder now writes the
 * `startedAt` the runner supplied; the read falls back to the derivation
 * for rows recorded before this column. Additive, nullable, IF NOT EXISTS.
 */

const TABLE = 'llm_dispatch_log';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS started_at`);
};
