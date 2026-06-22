/**
 * Autonomous Content Engine — persist the comparison-table gate verdict.
 *
 * The comparison-table gate (comparison-table-gate.js, runner step 3d) computes
 * a verdict in memory (run.comparison_table_result) and routes blocked / named-
 * competitor drafts to review. Without a column, finalize() dropped it, so the
 * durable autonomous_runs row kept only the short reviewer_notes codes — losing
 * the offending business names / caption / full findings the review queue needs.
 * Mirrors 20260528000021 (the other gate-verdict columns).
 *
 * Append-only + idempotent (hasColumn guard) — safe to re-run.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  if (!(await knex.schema.hasColumn('autonomous_runs', 'comparison_table_result'))) {
    await knex.schema.alterTable('autonomous_runs', (t) => {
      t.jsonb('comparison_table_result').notNullable().defaultTo('{}');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('autonomous_runs'))) return;
  if (await knex.schema.hasColumn('autonomous_runs', 'comparison_table_result')) {
    await knex.schema.alterTable('autonomous_runs', (t) => t.dropColumn('comparison_table_result'));
  }
};
