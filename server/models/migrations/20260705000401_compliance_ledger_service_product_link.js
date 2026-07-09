/**
 * Compliance ledger idempotency link.
 *
 * property_application_history (the FDACS application-record ledger) is
 * written one row per service_products row at completion. Link each ledger
 * row to the exact product row it came from so:
 *   - retries / double-completions can dedupe on the product row identity
 *     (unique index + ON CONFLICT DO NOTHING in the writer), and
 *   - the backfill can tell which service_products rows are already
 *     ledgered without guessing on (record, catalog product) pairs.
 *
 * ON DELETE SET NULL, deliberately: a state-auditable ledger row must
 * survive its source product row going away (the pest-recap re-commit path
 * deletes + re-inserts service_products). NO ACTION would make that delete
 * throw once ledger rows reference the products; CASCADE would silently
 * erase regulatory records. Historical rows keep NULL here — a plain unique
 * index allows unlimited NULLs, so they are unaffected.
 */
exports.up = async function (knex) {
  const hasPAH = await knex.schema.hasTable('property_application_history');
  if (!hasPAH) return;

  const hasCol = await knex.schema.hasColumn('property_application_history', 'service_product_id');
  if (!hasCol) {
    await knex.schema.alterTable('property_application_history', (t) => {
      t.uuid('service_product_id')
        .references('id')
        .inTable('service_products')
        .onDelete('SET NULL');
    });
  }

  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_property_application_history_service_product_id '
    + 'ON property_application_history (service_product_id)'
  );
};

exports.down = async function (knex) {
  const hasPAH = await knex.schema.hasTable('property_application_history');
  if (!hasPAH) return;

  await knex.raw('DROP INDEX IF EXISTS uq_property_application_history_service_product_id');

  const hasCol = await knex.schema.hasColumn('property_application_history', 'service_product_id');
  if (hasCol) {
    await knex.schema.alterTable('property_application_history', (t) => {
      t.dropColumn('service_product_id');
    });
  }
};
