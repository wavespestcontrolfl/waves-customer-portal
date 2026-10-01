// Per-product label mow hold (lawn report rebuild, P2b).
//
// Adds products_catalog.mow_hold_days (smallint, nullable): the number of days
// the product's LABEL says to hold off mowing after an application. A CHECK
// pins a set value to 1..14 so a typo in a seed or an admin edit fails loudly.
// NULL means the label says nothing about mowing; the lawn report then says
// nothing either (no default, no derivation, never "until dry").
//
// No seed and no data writes: values are entered later, product by product,
// from the label. Nothing customer-visible changes until a product has one.
// Idempotent: a re-run adds neither a second column nor a second constraint.

const CONSTRAINT = 'products_catalog_mow_hold_days_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  if (!(await knex.schema.hasColumn('products_catalog', 'mow_hold_days'))) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.smallint('mow_hold_days');
    });
  }

  const existing = await knex.raw(
    "SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'products_catalog'::regclass",
    [CONSTRAINT],
  );
  if (!existing.rows.length) {
    await knex.raw(`
      ALTER TABLE products_catalog
      ADD CONSTRAINT ${CONSTRAINT}
      CHECK (mow_hold_days IS NULL OR (mow_hold_days BETWEEN 1 AND 14))
    `);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex.raw(`ALTER TABLE products_catalog DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  if (await knex.schema.hasColumn('products_catalog', 'mow_hold_days')) {
    await knex.schema.alterTable('products_catalog', (t) => {
      t.dropColumn('mow_hold_days');
    });
  }
};
