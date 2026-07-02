/**
 * A DEDICATED marker for "this per-visit invoice was SETTLED as non-cash annual-prepay
 * coverage" — distinct from `invoices.annual_prepay_term_id`, which means "this IS the
 * term's own annual-prepay invoice" (loadInvoiceAnnualPrepay renders it as the prepay
 * invoice, and admin routes cancel the referenced term). Reusing that column for covered
 * visit invoices would mis-render residual invoices and let an operator cancel real
 * coverage from the wrong invoice — so coverage settlement gets its own column.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'annual_prepay_covered_term_id'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.uuid('annual_prepay_covered_term_id')
        .references('id')
        .inTable('annual_prepay_terms')
        .onDelete('SET NULL');
      t.index('annual_prepay_covered_term_id');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'annual_prepay_covered_term_id')) {
    await knex.schema.alterTable('invoices', (t) => t.dropColumn('annual_prepay_covered_term_id'));
  }
};
