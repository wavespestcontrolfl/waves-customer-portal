const SKIP = !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

// Every fixture and the migration run inside a transaction that is always
// rolled back, so a populated database never loses its real catalog rows.
d('20260928020000 catalog package-size corrections', () => {
  let db;
  const migration = require('../models/migrations/20260928020000_catalog_package_size_corrections');
  const names = ['Dominion 2L 1 gal', 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide'];
  const ROLLBACK = new Error('rollback');

  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { await db.destroy(); });

  const inRollback = async (fn) => {
    await expect(db.transaction(async (trx) => { await fn(trx); throw ROLLBACK; })).rejects.toBe(ROLLBACK);
  };

  const seed = (trx, rows) => trx('products_catalog').insert(rows.map((r) => ({
    category: 'Insecticide', active_ingredient: 'x', epa_reg_number: 'x', formulation: 'SC', active: true, ...r,
  })));

  test('fixes rows still at the old sizes', async () => {
    await inRollback(async (trx) => {
      await trx('products_catalog').whereIn('name', names).update({ name: trx.raw("name || ' (pre-test)'") });
      await seed(trx, [
        { name: names[0], container_size: '1 gal', unit_size_oz: 128, best_price: 469.53 },
        { name: names[1], container_size: '64 oz', unit_size_oz: 64, best_price: 3485.35 },
      ]);
      await migration.up(trx);
      const rows = await trx('products_catalog').whereIn('name', names).orderBy('name');
      expect(rows.map((r) => [r.container_size, Number(r.unit_size_oz), Number(r.best_price)])).toEqual([
        ['4 x 1 gal case', 512, 469.53],
        ['1.33 oz', 1.33, 59.99],
      ]);
    });
  });

  test('leaves hand-corrected rows alone', async () => {
    await inRollback(async (trx) => {
      await trx('products_catalog').whereIn('name', names).update({ name: trx.raw("name || ' (pre-test)'") });
      await seed(trx, [{ name: names[1], container_size: '2 x 1.33 oz', unit_size_oz: 2.66, best_price: 110 }]);
      await migration.up(trx);
      const row = await trx('products_catalog').where({ name: names[1] }).first();
      expect([row.container_size, Number(row.unit_size_oz), Number(row.best_price)]).toEqual(['2 x 1.33 oz', 2.66, 110]);
    });
  });
});
