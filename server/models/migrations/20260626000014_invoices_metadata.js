// Adds invoices.metadata (jsonb) — structured extras attached to an invoice.
// Used by the charge-in-person annual-prepay flow to carry the coverage config on
// the (unpaid) invoice so the payment webhook can create + activate the term when
// it's paid (deferred-term, so an aborted in-person charge leaves no orphan term).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'metadata')) return;
  await knex.schema.alterTable('invoices', (t) => {
    t.jsonb('metadata');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'metadata'))) return;
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('metadata');
  });
};
