/**
 * invoices.batch_key — idempotency key for POST /admin/invoices/batch.
 *
 * The batch route loops customers with no cross-customer transaction, so a
 * retry after a partial-failure response used to re-create rows the first
 * attempt already made (and re-text them with sendImmediately). The route now
 * persists the client's batchKey on each created row; the partial unique
 * index makes a concurrent duplicate for the same (customer, batch) lose
 * atomically at the DB instead of racing the pre-check SELECT.
 *
 * Nullable: every non-batch create path leaves it NULL, and NULLs are exempt
 * from the index.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('invoices');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('invoices', 'batch_key');
  if (!hasColumn) {
    await knex.schema.alterTable('invoices', (t) => {
      t.string('batch_key', 100);
    });
  }
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS invoices_customer_batch_key_uniq '
    + 'ON invoices (customer_id, batch_key) WHERE batch_key IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('invoices');
  if (!hasTable) return;
  await knex.raw('DROP INDEX IF EXISTS invoices_customer_batch_key_uniq');
  const hasColumn = await knex.schema.hasColumn('invoices', 'batch_key');
  if (hasColumn) {
    await knex.schema.alterTable('invoices', (t) => {
      t.dropColumn('batch_key');
    });
  }
};
