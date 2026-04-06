exports.up = async function (knex) {
  const cols = await knex.raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'products_catalog'");
  const existing = cols.rows.map(r => r.column_name);

  await knex.schema.alterTable('products_catalog', t => {
    if (!existing.includes('subcategory')) t.string('subcategory', 100);
  });

  if (!existing.includes('category') || true) {
    try { await knex.raw("ALTER TABLE products_catalog ALTER COLUMN category TYPE varchar(100)"); } catch { /* already wide enough */ }
  }
};

exports.down = async function (knex) {
  try { await knex.schema.alterTable('products_catalog', t => { t.dropColumn('subcategory'); }); } catch {}
  try { await knex.raw("ALTER TABLE products_catalog ALTER COLUMN category TYPE varchar(30)"); } catch {}
};
