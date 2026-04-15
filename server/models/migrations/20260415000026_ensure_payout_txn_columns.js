/**
 * Ensure stripe_payout_transactions has fee/amount/net columns.
 * Older deploys created the table without them (the initial create guard
 * in 20260414000010_banking.js skips if the table already exists), which
 * caused `column "fee" does not exist` at runtime.
 */

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('stripe_payout_transactions');
  if (!hasTable) return;

  const adds = [];
  if (!(await knex.schema.hasColumn('stripe_payout_transactions', 'fee'))) adds.push('fee');
  if (!(await knex.schema.hasColumn('stripe_payout_transactions', 'amount'))) adds.push('amount');
  if (!(await knex.schema.hasColumn('stripe_payout_transactions', 'net'))) adds.push('net');

  if (adds.length) {
    await knex.schema.alterTable('stripe_payout_transactions', (t) => {
      if (adds.includes('fee')) t.decimal('fee', 10, 2).defaultTo(0);
      if (adds.includes('amount')) t.decimal('amount', 10, 2);
      if (adds.includes('net')) t.decimal('net', 10, 2);
    });
  }
};

exports.down = async function () {
  // No-op on down — don't drop columns that might hold data.
};
