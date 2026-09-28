/**
 * bank_transactions.plaid_account_id — the Plaid account that fed a
 * source='plaid' row. A replacement connection for the same bank account
 * gets NEW transaction ids, so overlap with an earlier feed is judged by
 * account, not by id (plaid-sync setupItem). NULL on CSV rows.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  if (await knex.schema.hasColumn('bank_transactions', 'plaid_account_id')) return;
  await knex.schema.alterTable('bank_transactions', t => {
    t.string('plaid_account_id', 100);
  });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('bank_transactions', 'plaid_account_id')) {
    await knex.schema.alterTable('bank_transactions', t => {
      t.dropColumn('plaid_account_id');
    });
  }
};
