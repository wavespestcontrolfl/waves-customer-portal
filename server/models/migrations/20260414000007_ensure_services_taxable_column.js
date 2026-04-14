/**
 * Migration — Ensure services table has is_taxable column
 *
 * Migration 105 skips CREATE TABLE if 'services' already exists,
 * which means is_taxable may never have been added. This migration
 * adds it if missing.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('services');
  if (!hasTable) return;

  const hasCol = await knex.schema.hasColumn('services', 'is_taxable');
  if (!hasCol) {
    await knex.schema.alterTable('services', (t) => {
      t.boolean('is_taxable').defaultTo(true);
      t.string('tax_category', 50);
      t.string('tax_service_key', 80);
    });
  }
};

exports.down = async function () {
  // No-op — don't drop columns that may have existed before
};
