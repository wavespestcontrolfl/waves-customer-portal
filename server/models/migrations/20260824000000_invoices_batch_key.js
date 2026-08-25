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
 *
 * batch_fingerprint — canonical hash of the batch payload the key was first
 * used with (title/lineItems/notes/dueDate/taxRate/sendImmediately). A keyed
 * duplicate whose request fingerprint differs is a MISUSED key (same key,
 * changed terms), not a retry — the route refuses it instead of silently
 * keeping old terms for existing customers while minting new terms for the
 * rest.
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
  const hasFingerprint = await knex.schema.hasColumn('invoices', 'batch_fingerprint');
  if (!hasFingerprint) {
    await knex.schema.alterTable('invoices', (t) => {
      t.string('batch_fingerprint', 64);
    });
  }
  // Batch-key registry: the key→fingerprint binding enforced ATOMICALLY for
  // the whole batch (unique PK; first request claims the key, every later
  // request with a different payload is refused up front) — per-row
  // fingerprint checks alone let one key produce invoices with conflicting
  // terms across customers.
  if (!(await knex.schema.hasTable('invoice_batch_keys'))) {
    await knex.schema.createTable('invoice_batch_keys', (t) => {
      t.string('batch_key', 100).primary();
      t.string('fingerprint', 64).notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
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
  const hasFingerprint = await knex.schema.hasColumn('invoices', 'batch_fingerprint');
  if (hasFingerprint) {
    await knex.schema.alterTable('invoices', (t) => {
      t.dropColumn('batch_fingerprint');
    });
  }
  await knex.schema.dropTableIfExists('invoice_batch_keys');
};
