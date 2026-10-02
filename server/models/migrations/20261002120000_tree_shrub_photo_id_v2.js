/**
 * App Photo ID v2 for tree & shrub / palm (owner 2026-10-02, "same as pest").
 *
 * `tree_shrub_assessments` has no report_contract column (lawn and pest embed
 * their v2 object there), so the plant engine's customer `v2` object and its
 * admin-only `internal` record get their own nullable jsonb columns. Additive
 * only: existing rows and the tech paths never read or write them.
 */

async function addIfMissing(knex, table, column, build) {
  if (await knex.schema.hasTable(table) && !(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (t) => { build(t); });
  }
}

exports.up = async function up(knex) {
  await addIfMissing(knex, 'tree_shrub_assessments', 'result_v2', (t) => t.jsonb('result_v2').nullable());
  await addIfMissing(knex, 'tree_shrub_assessments', 'v2_internal', (t) => t.jsonb('v2_internal').nullable());
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('tree_shrub_assessments'))) return;
  for (const column of ['v2_internal', 'result_v2']) {
    if (await knex.schema.hasColumn('tree_shrub_assessments', column)) {
      await knex.schema.alterTable('tree_shrub_assessments', (t) => { t.dropColumn(column); });
    }
  }
};
