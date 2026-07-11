/**
 * estimate_deposits.failed_refund_ids — durable fence for bounced deposit
 * refunds. Deposits have no payments row, so the refund-bounce handler needs
 * somewhere PI-addressable to record a failed refund id; the deposit
 * reversal path (handleDepositChargeReversed) consults it so a LATE
 * charge.refunded delivered after its refund already failed cannot flip the
 * deposit ledger to refunded for money Stripe kept.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_deposits'))) return;
  if (await knex.schema.hasColumn('estimate_deposits', 'failed_refund_ids')) return;
  await knex.schema.alterTable('estimate_deposits', (t) => {
    t.jsonb('failed_refund_ids').notNullable().defaultTo('[]');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimate_deposits'))) return;
  if (!(await knex.schema.hasColumn('estimate_deposits', 'failed_refund_ids'))) return;
  await knex.schema.alterTable('estimate_deposits', (t) => {
    t.dropColumn('failed_refund_ids');
  });
};
