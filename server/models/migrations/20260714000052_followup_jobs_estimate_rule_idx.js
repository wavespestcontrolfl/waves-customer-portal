'use strict';

/**
 * Full-lifecycle lookup index on estimate_followup_jobs (codex 2736 r7):
 * the enqueue guard checks (estimate_id, rule_key) with NO status filter —
 * terminal shadow/done/skipped/failed rows are deliberately visible to it
 * (one job lifecycle per estimate+rule) — but 20260714000050 only indexed
 * the pending slice, so as the audit trail grows every view hook and sweep
 * candidate would scan the table. Separate migration (not an edit to
 * ...000050) because that file has already run in PR environments.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_jobs'))) return;
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS estimate_followup_jobs_estimate_rule_idx
    ON estimate_followup_jobs (estimate_id, rule_key)
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS estimate_followup_jobs_estimate_rule_idx');
};
