/**
 * Set is_taxable = false on all services except those with "commercial" in the name.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  await knex('services')
    .where('name', 'not ilike', '%commercial%')
    .update({ is_taxable: false });
};

exports.down = async function (knex) {
  // Restore taxable to true for all services (original default)
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services').update({ is_taxable: true });
};
