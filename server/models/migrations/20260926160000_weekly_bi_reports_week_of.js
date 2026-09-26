// One Weekly BI report per ET week (Codex #4870 r6). The report insert runs
// inside the agent loop and can finish after its run hit the deadline, and a
// retried or overlapping run saves again; with no occurrence key those became
// a second dashboard report for the same week. week_of (the ET Monday, the
// same key the owner text's once-per-week claim uses) makes the save an
// upsert. A plain unique index: PostgreSQL treats NULLs as distinct, so rows
// saved before this column existed stay valid without a backfill.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('weekly_bi_reports'))) return;
  if (!(await knex.schema.hasColumn('weekly_bi_reports', 'week_of'))) {
    await knex.schema.alterTable('weekly_bi_reports', (t) => { t.date('week_of'); });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS weekly_bi_reports_week_of_unique ON weekly_bi_reports (week_of)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('weekly_bi_reports'))) return;
  await knex.raw('DROP INDEX IF EXISTS weekly_bi_reports_week_of_unique');
  if (await knex.schema.hasColumn('weekly_bi_reports', 'week_of')) {
    await knex.schema.alterTable('weekly_bi_reports', (t) => { t.dropColumn('week_of'); });
  }
};
