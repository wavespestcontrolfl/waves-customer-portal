/**
 * Banking deep-fix migration:
 *   - stripe_sync_state.last_created_at — watermark for payout pagination
 *   - bank_reconciliation.status — lifecycle state (draft/confirmed/rejected)
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('stripe_sync_state')) {
    if (!(await knex.schema.hasColumn('stripe_sync_state', 'last_created_at'))) {
      await knex.schema.alterTable('stripe_sync_state', t => {
        t.timestamp('last_created_at', { useTz: true });
      });
    }
  }

  if (await knex.schema.hasTable('bank_reconciliation')) {
    if (!(await knex.schema.hasColumn('bank_reconciliation', 'status'))) {
      await knex.schema.alterTable('bank_reconciliation', t => {
        t.text('status').defaultTo('confirmed'); // draft | confirmed | rejected
        t.index('status');
      });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('stripe_sync_state') &&
      await knex.schema.hasColumn('stripe_sync_state', 'last_created_at')) {
    await knex.schema.alterTable('stripe_sync_state', t => t.dropColumn('last_created_at'));
  }
  if (await knex.schema.hasTable('bank_reconciliation') &&
      await knex.schema.hasColumn('bank_reconciliation', 'status')) {
    await knex.schema.alterTable('bank_reconciliation', t => t.dropColumn('status'));
  }
};
