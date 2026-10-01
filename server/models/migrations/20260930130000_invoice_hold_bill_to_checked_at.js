/**
 * Collections hold - the scheduled-invoice sender's held Bill-To recheck marker (#5424 round 14).
 *
 * A combined-visit (packet) invoice or a termite renewal successor's prepay invoice has no payer_id
 * stamped until the live Bill-To fence resolves it, so while the homeowner has an active collection
 * hold the sender's due query must still admit it to that fence (a payer assigned since queueing routes
 * it to the payer, held homeowner or not). Admitted on EVERY due cycle, a large held cohort consumed
 * delivery page slots ahead of ordinary invoices. Once the fence confirms a held row is still self-pay
 * the sender stamps this column, and the due query skips a held row whose stamp is fresh (a payer change
 * is picked up at the next recheck interval; a hold release sends at the next tick regardless).
 *
 * invoices.hold_bill_to_checked_at - nullable timestamptz, no default, read only by the sender's due
 * query and written only by processScheduledSends. Additive, hasTable/hasColumn-guarded, safe to rerun.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('invoices')
    && !(await knex.schema.hasColumn('invoices', 'hold_bill_to_checked_at'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.timestamp('hold_bill_to_checked_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('invoices')
    && await knex.schema.hasColumn('invoices', 'hold_bill_to_checked_at')) {
    await knex.schema.alterTable('invoices', (t) => {
      t.dropColumn('hold_bill_to_checked_at');
    });
  }
};
