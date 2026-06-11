// Lawn protocol lines reference "Celsius" (st_augustine Mar spot-treat) and
// "chlorantraniliprole" (bermuda Jul armyworm MOA rotation) but no alias rows
// connect them to their catalog products, so the lawn-mix preview flags the
// lines as unmatched and withholds label-rate math. Both products already
// exist in products_catalog; this seed only adds the missing aliases.
const ALIAS_GAPS = [
  { productName: 'Celsius WG', alias: 'Celsius' },
  { productName: 'Acelepryn Insecticide', alias: 'chlorantraniliprole' },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('product_aliases'))) return;

  for (const { productName, alias } of ALIAS_GAPS) {
    const product = await knex('products_catalog')
      .where({ name: productName })
      .first('id');
    if (!product) continue;

    const existing = await knex('product_aliases')
      .where({ product_id: product.id, alias_name: alias })
      .whereNull('vendor_id')
      .first('id');
    if (existing) continue;

    await knex('product_aliases').insert({
      product_id: product.id,
      alias_name: alias,
      vendor_id: null,
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('product_aliases'))) return;

  for (const { productName, alias } of ALIAS_GAPS) {
    const product = await knex('products_catalog')
      .where({ name: productName })
      .first('id');
    if (!product) continue;

    await knex('product_aliases')
      .where({ product_id: product.id, alias_name: alias })
      .whereNull('vendor_id')
      .del();
  }
};
