/**
 * leads.why_checked_at — when the nightly lead-why filler last examined the
 * lead. The bounded nightly run scans least-recently-checked leads first, so
 * every lead in the lookback is reached even when more than one run's cap is
 * eligible (Codex #8521). why_filled_at (20261125130000) still marks a write.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('leads', 'why_checked_at'))) {
    await knex.schema.alterTable('leads', (t) => {
      t.timestamp('why_checked_at');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('leads', 'why_checked_at')) {
    await knex.schema.alterTable('leads', (t) => {
      t.dropColumn('why_checked_at');
    });
  }
};
