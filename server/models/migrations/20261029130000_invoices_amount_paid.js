/**
 * invoices.amount_paid: money already received on an invoice that is still open.
 *
 * Partial payments (owner 2026-10-28/29): the Invoices page will record part of a bill and the
 * rest stays owed. "Amount owed" becomes total - credit_applied - amount_paid, floored at 0
 * (invoiceAmountDue in server/services/invoice-helpers.js and its SQL copies).
 *
 * Same precision and scale as invoices.total, NOT NULL, default 0. No backfill: every existing
 * invoice has had no partial payment, so 0 is the true value. Nothing writes the column yet; the
 * writer ships in a later change, so this migration alone changes no behavior.
 *
 * A pushed migration is frozen. The down drops only what this file added.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('invoices', 'amount_paid'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.decimal('amount_paid', 10, 2).notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('invoices', 'amount_paid')) {
    await knex.schema.alterTable('invoices', (t) => { t.dropColumn('amount_paid'); });
  }
};
