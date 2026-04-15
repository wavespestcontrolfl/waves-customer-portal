/**
 * Florida: lawn maintenance for residential customers is NOT taxable
 * (FL DOR TIP 16A01-02). Commercial lawn services remain taxable.
 * Set residential_taxable = false for lawn_maintenance category.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('service_taxability');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_taxability', 'residential_taxable');
  if (!hasCol) return;

  const updated = await knex('service_taxability')
    .whereIn('tax_category', ['lawn_maintenance', 'lawn_care', 'lawn'])
    .update({ residential_taxable: false });

  if (!updated) {
    // eslint-disable-next-line no-console
    console.warn('[migration 20260414000022] No lawn service_taxability rows updated — verify tax_category naming.');
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('service_taxability');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('service_taxability', 'residential_taxable');
  if (!hasCol) return;

  await knex('service_taxability')
    .whereIn('tax_category', ['lawn_maintenance', 'lawn_care', 'lawn'])
    .update({ residential_taxable: true });
};
