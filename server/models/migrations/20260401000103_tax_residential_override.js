/**
 * Migration 103 — Add residential_taxable override to service_taxability
 *
 * Florida: residential pest control is NOT subject to sales tax,
 * but commercial pest control IS. This column allows per-service override.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('service_taxability');
  if (!hasTable) return;

  const hasCol = await knex.schema.hasColumn('service_taxability', 'residential_taxable');
  if (!hasCol) {
    await knex.schema.alterTable('service_taxability', (t) => {
      t.boolean('residential_taxable').defaultTo(true);
    });
  }

  // Set residential pest control services as NOT taxable for residential customers
  // FL: residential pest control is exempt; commercial is taxable
  await knex('service_taxability')
    .where('tax_category', 'pest_control')
    .update({ residential_taxable: false });
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('service_taxability');
  if (!hasTable) return;

  const hasCol = await knex.schema.hasColumn('service_taxability', 'residential_taxable');
  if (hasCol) {
    await knex.schema.alterTable('service_taxability', (t) => {
      t.dropColumn('residential_taxable');
    });
  }
};
