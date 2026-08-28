// Account credit auto-apply is the CUSTOMER's choice (owner ruling
// 2026-08-28): the balance stays on the account until they turn the portal
// slider on. Every automatic apply seam (completion, dunning touch, send,
// project report, pay page, charge-now, Tap-to-Pay handoff) checks this
// flag inside applyAccountCreditToInvoice; the admin apply-credit route and
// estimate acceptance (customer-initiated, price shown net of credit) are
// not automatic. Everyone starts OFF — including customers whose credit
// was auto-applied before this landed (owner: "start them off").
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'auto_apply_account_credit')) return;
  await knex.schema.alterTable('customers', (table) => {
    table.boolean('auto_apply_account_credit').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'auto_apply_account_credit'))) return;
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumn('auto_apply_account_credit');
  });
};
