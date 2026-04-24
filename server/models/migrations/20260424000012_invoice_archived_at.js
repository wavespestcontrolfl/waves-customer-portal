/**
 * Adds archived_at to invoices so voided invoices can be tucked out of
 * the default list view without deleting the row. Partial index because
 * the vast majority of invoices will have NULL archived_at and we don't
 * want to pay for B-tree space on the noise.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('invoices', (t) => {
    t.timestamp('archived_at');
  });
  // Partial index — only indexed rows are the archived ones. Default list
  // query filters WHERE archived_at IS NULL, so this index accelerates
  // the "show archived" view without bloating writes to the common path.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_invoices_archived_at ON invoices (archived_at) WHERE archived_at IS NOT NULL`
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_invoices_archived_at`);
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('archived_at');
  });
};
