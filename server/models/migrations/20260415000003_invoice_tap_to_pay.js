/**
 * Invoice reconciliation columns for Stripe Tap to Pay (Path A).
 *
 * Techs collect in-person via the native Stripe Terminal app. Admin reconciles
 * by pasting the Stripe charge id (or picking from a recent charges list) and
 * marking the invoice paid.
 */
exports.up = async function (knex) {
  const hasCol = async (col) => knex.schema.hasColumn('invoices', col);

  if (!(await hasCol('stripe_charge_id'))) {
    await knex.schema.alterTable('invoices', (t) => t.string('stripe_charge_id', 100));
  }
  if (!(await hasCol('collected_via'))) {
    // 'online' | 'terminal_tap_to_pay' | 'terminal_card_reader' | 'manual_check' | 'manual_cash' | 'ach_manual'
    await knex.schema.alterTable('invoices', (t) => t.string('collected_via', 40));
  }
  if (!(await hasCol('reconciled_by'))) {
    await knex.schema.alterTable('invoices', (t) => t.uuid('reconciled_by'));
  }
  if (!(await hasCol('reconciled_at'))) {
    await knex.schema.alterTable('invoices', (t) => t.timestamp('reconciled_at'));
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('stripe_charge_id');
    t.dropColumn('collected_via');
    t.dropColumn('reconciled_by');
    t.dropColumn('reconciled_at');
  });
};
