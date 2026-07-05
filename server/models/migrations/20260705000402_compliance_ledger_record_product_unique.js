/**
 * Compliance ledger append-safety on the STABLE identity.
 *
 * 20260705000401 linked each ledger row to its exact service_products row
 * for retry idempotency. But product rows are not immortal: the pest-recap
 * re-commit path DELETEs and re-inserts service_products, which SET-NULLs
 * the ledger link. After such a replacement, a writer re-run (legacy
 * re-fire, backfill, retry) no longer conflicts on service_product_id for
 * the replaced rows. The writer's in-code scan dedupes those sequentially
 * (an orphaned row keeps its product_id, so the legacy-identity fallback
 * catches it), but two concurrent writers had no DB-level guard.
 *
 * This adds the stable-identity unique: ONE ledger row per (service_record,
 * catalog product). Both live writers already guarantee one service_products
 * row per catalog product per record (the V2 completion loop dedupes by
 * productId; the compliance writer resolves one catalog row per product), so
 * the index only denies double-ledgering the same application. Partial —
 * rows with no resolved catalog product (product_id IS NULL) stay outside
 * the index and rely on the writer's conservative unidentified-row skip.
 * The writer inserts ON CONFLICT DO NOTHING with no target, so a violation
 * of EITHER unique index resolves a race to a single row.
 *
 * Deliberately fail-fast: prod's ledger is empty at ship time, so index
 * creation cannot collide. If some environment ever holds duplicate
 * (record, product) pairs, CREATE UNIQUE INDEX fails, the pre-deploy
 * migration step fails, and the deploy is rejected — a state-auditable
 * ledger with duplicates needs a human, not a silent dedupe in a migration.
 */
exports.up = async function (knex) {
  const hasPAH = await knex.schema.hasTable('property_application_history');
  if (!hasPAH) return;

  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_property_application_history_record_product '
    + 'ON property_application_history (service_record_id, product_id) '
    + 'WHERE product_id IS NOT NULL'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_property_application_history_record_product');
};
