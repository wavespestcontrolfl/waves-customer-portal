// Lawn protocol lines reference "Celsius" (st_augustine Mar spot-treat) and
// "chlorantraniliprole" (bermuda Jul armyworm MOA rotation) but no alias rows
// connect them to their catalog products, so the lawn-mix preview flags the
// lines as unmatched and withholds label-rate math. This seed only adds the
// missing aliases; it follows the seed-record pattern of
// 20260528000041_waveguard_protocol_product_aliases so rollback removes only
// rows this migration inserted.
const SEED_ID = 'protocol-alias-gap-seed-2026-06-11';
const SEED_RECORD_TABLE = 'protocol_alias_gap_seed_records';

// productNames is an ordered preference list: prod carries the pure
// chlorantraniliprole product ("Acelepryn Insecticide"), but repo-seeded
// dev/preview databases only have "Acelepryn Xtra"
// (20260430000010_seed_core_waveguard_products) — fall back rather than
// silently leaving the priced line unmatched there.
const ALIAS_GAPS = [
  { productNames: ['Celsius WG'], alias: 'Celsius' },
  { productNames: ['Acelepryn Insecticide', 'Acelepryn Xtra'], alias: 'chlorantraniliprole' },
];

async function ensureSeedRecordTable(knex) {
  if (await knex.schema.hasTable(SEED_RECORD_TABLE)) return;

  await knex.schema.createTable(SEED_RECORD_TABLE, (table) => {
    table.increments('id').primary();
    table.string('seed_id').notNullable();
    table.uuid('alias_id').notNullable();
    table.string('alias_name').notNullable();
    table.uuid('product_id').notNullable();
    table.timestamps(true, true);
    table.unique(['seed_id', 'alias_id']);
  });
}

async function findFirstProduct(knex, productNames) {
  for (const name of productNames) {
    const product = await knex('products_catalog').where({ name }).first('id');
    if (product) return product;
  }
  return null;
}

async function ensureAlias(knex, productId, aliasName) {
  if (!productId || !aliasName) return;

  // Check vendor-less aliases globally, not per-product: the unique index on
  // (alias_name, vendor_id) does not collide on NULL vendor_id, and a second
  // row for the same shorthand would make matchCatalogProduct ambiguous.
  const existing = await knex('product_aliases')
    .where({ alias_name: aliasName })
    .whereNull('vendor_id')
    .first();
  if (existing) {
    // Existing vendor-less aliases may belong to prior migrations or manual
    // fixes. Do not repoint them; rollback cannot safely infer the owner.
    return;
  }

  const [created] = await knex('product_aliases').insert({
    product_id: productId,
    alias_name: aliasName,
    vendor_id: null,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  }).returning('id');
  const aliasId = created?.id || created;
  if (!aliasId) return;

  await knex(SEED_RECORD_TABLE).insert({
    seed_id: SEED_ID,
    alias_id: aliasId,
    alias_name: aliasName,
    product_id: productId,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasTable('product_aliases'))) return;
  await ensureSeedRecordTable(knex);

  for (const { productNames, alias } of ALIAS_GAPS) {
    const product = await findFirstProduct(knex, productNames);
    if (!product) continue;
    await ensureAlias(knex, product.id, alias);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('product_aliases'))) return;
  if (!(await knex.schema.hasTable(SEED_RECORD_TABLE))) return;

  const insertedAliasIds = (await knex(SEED_RECORD_TABLE)
    .where({ seed_id: SEED_ID })
    .select('alias_id'))
    .map((row) => row.alias_id)
    .filter(Boolean);

  if (insertedAliasIds.length) {
    await knex('product_aliases')
      .whereIn('id', insertedAliasIds)
      .del();
  }

  await knex.schema.dropTable(SEED_RECORD_TABLE);
};
