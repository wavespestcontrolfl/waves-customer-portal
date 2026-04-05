exports.up = async function (knex) {
  await knex.schema.alterTable('products_catalog', t => {
    // Widen category from 30 to 100 chars
    t.string('subcategory', 100);
  });

  // Widen category column (ALTER COLUMN TYPE)
  await knex.raw("ALTER TABLE products_catalog ALTER COLUMN category TYPE varchar(100)");
};

exports.down = async function (knex) {
  await knex.schema.alterTable('products_catalog', t => {
    t.dropColumn('subcategory');
  });
  await knex.raw("ALTER TABLE products_catalog ALTER COLUMN category TYPE varchar(30)");
};
