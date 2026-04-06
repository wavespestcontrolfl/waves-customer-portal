/**
 * Add decline_reason to estimates for pipeline analytics
 */
exports.up = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'estimates' })
    .pluck('column_name');

  await knex.schema.alterTable('estimates', (t) => {
    if (!cols.includes('decline_reason')) t.string('decline_reason', 100);
  });
};

exports.down = async function (knex) {
  const cols = await knex('information_schema.columns')
    .where({ table_name: 'estimates' })
    .pluck('column_name');

  await knex.schema.alterTable('estimates', (t) => {
    if (cols.includes('decline_reason')) t.dropColumn('decline_reason');
  });
};
