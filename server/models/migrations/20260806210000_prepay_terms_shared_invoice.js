/**
 * Allow several annual_prepay_terms to share ONE prepay invoice.
 *
 * A multi-property group accept (one customer, two properties, both prepaying
 * the year) mints a SINGLE combined prepay invoice with one term per property
 * — each term keeps its own coverage config (source_estimate_id stays UNIQUE),
 * but `prepay_invoice_id` can no longer be unique. Replaced with a plain
 * index so the renewal/refund readers keep their lookup performance.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  await knex.raw('ALTER TABLE annual_prepay_terms DROP CONSTRAINT IF EXISTS annual_prepay_terms_invoice_unique');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_annual_prepay_terms_invoice ON annual_prepay_terms (prepay_invoice_id) WHERE prepay_invoice_id IS NOT NULL');
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_annual_prepay_terms_invoice');
  // Restore the one-term-per-invoice constraint. Fails (deliberately) if
  // grouped terms sharing an invoice exist — those rows must be resolved
  // before rolling back, never silently dropped.
  await knex.raw('ALTER TABLE annual_prepay_terms ADD CONSTRAINT annual_prepay_terms_invoice_unique UNIQUE (prepay_invoice_id)');
};
