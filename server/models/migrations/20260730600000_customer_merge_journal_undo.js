/**
 * Journal-backed merge undo — two nullable columns on customer_merge_journal:
 *
 * repointed_ids — jsonb { version, tables: { "<table>.<column>": [row ids] },
 * stripe_transferred_id } written by executeMerge so a merge can be reverted
 * row-precisely (the pre-existing `repointed` jsonb only keeps COUNTS).
 * Nullable on purpose: pre-upgrade journal rows have no per-row record and
 * the revert endpoint refuses them explicitly.
 *
 * undone_by — who triggered the revert (admin identifier), pairing with the
 * pre-existing undone_at that nothing wrote until now.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_merge_journal'))) return;
  if (!(await knex.schema.hasColumn('customer_merge_journal', 'repointed_ids'))) {
    await knex.schema.alterTable('customer_merge_journal', (t) => {
      t.jsonb('repointed_ids').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('customer_merge_journal', 'undone_by'))) {
    await knex.schema.alterTable('customer_merge_journal', (t) => {
      t.string('undone_by', 100).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_merge_journal'))) return;
  if (await knex.schema.hasColumn('customer_merge_journal', 'undone_by')) {
    await knex.schema.alterTable('customer_merge_journal', (t) => {
      t.dropColumn('undone_by');
    });
  }
  if (await knex.schema.hasColumn('customer_merge_journal', 'repointed_ids')) {
    await knex.schema.alterTable('customer_merge_journal', (t) => {
      t.dropColumn('repointed_ids');
    });
  }
};
