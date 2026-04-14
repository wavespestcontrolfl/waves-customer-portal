exports.up = async function (knex) {
  await knex.schema.alterTable('customers', (t) => {
    t.timestamp('deleted_at').nullable().defaultTo(null);
  });

  await knex.schema.raw(
    'CREATE INDEX customers_deleted_at_idx ON customers (deleted_at)'
  );
};

exports.down = async function (knex) {
  await knex.schema.raw('DROP INDEX IF EXISTS customers_deleted_at_idx');

  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('deleted_at');
  });
};
