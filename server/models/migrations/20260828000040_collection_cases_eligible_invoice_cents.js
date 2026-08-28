// Account-level collections (owner ruling 2026-08-28): a case now covers
// EVERY open invoice, so the approval is for a set of line items, not one
// number. The per-invoice remainder the operator approved is snapshotted
// here (jsonb {invoiceId: cents}) so origination can hold the dial to
// exactly those line items — offsetting edits (one invoice paid down,
// another edited up) leave the aggregate intact but change what Sandy
// names. Nullable: rows approved before this landed fall back to the
// aggregate compare.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('collection_cases'))) return;
  if (await knex.schema.hasColumn('collection_cases', 'eligible_invoice_cents')) return;
  await knex.schema.alterTable('collection_cases', (table) => {
    table.jsonb('eligible_invoice_cents');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('collection_cases'))) return;
  if (!(await knex.schema.hasColumn('collection_cases', 'eligible_invoice_cents'))) return;
  await knex.schema.alterTable('collection_cases', (table) => {
    table.dropColumn('eligible_invoice_cents');
  });
};
