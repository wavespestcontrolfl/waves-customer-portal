/**
 * Add composite index on tax_exemptions(customer_id, active, verified).
 * Tax calculation runs this lookup on every invoice; full scan grows with customer base.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('tax_exemptions');
  if (!hasTable) return;

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_tax_exemptions_lookup ON tax_exemptions(customer_id, active, verified)'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_tax_exemptions_lookup');
};
