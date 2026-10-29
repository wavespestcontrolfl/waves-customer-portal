// 20261029010000_products_catalog_bid_list: adds products_catalog.bid_list (boolean, NOT NULL, default false), no data change;
// idempotent both ways; down drops the column.
const migration = require('../models/migrations/20261029010000_products_catalog_bid_list');

function fakeKnex({ table = true, column = false } = {}) {
  const calls = [];
  const t = {
    boolean: jest.fn((name) => { calls.push(['boolean', name]); return { notNullable: () => ({ defaultTo: (v) => calls.push(['default', name, v]) }) }; }),
    dropColumn: jest.fn((name) => calls.push(['dropColumn', name])),
  };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => table),
      hasColumn: jest.fn(async () => column),
      alterTable: jest.fn(async (_name, fn) => { fn(t); }),
    },
    // Any other call would be a data change.
    raw: jest.fn(), insert: jest.fn(),
  };
  return { knex, calls };
}

describe('products_catalog.bid_list migration', () => {
  test('up adds a NOT NULL boolean that defaults to false, and changes no data', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls).toEqual([['boolean', 'bid_list'], ['default', 'bid_list', false]]);
    expect(knex.raw).not.toHaveBeenCalled();
  });
  test('up does nothing when the column is already there or the table is missing', async () => {
    for (const opts of [{ column: true }, { table: false }]) {
      const { knex } = fakeKnex(opts);
      await migration.up(knex);
      expect(knex.schema.alterTable).not.toHaveBeenCalled();
    }
  });
  test('down drops the column, and does nothing when it is already gone', async () => {
    const present = fakeKnex({ column: true });
    await migration.down(present.knex);
    expect(present.calls).toEqual([['dropColumn', 'bid_list']]);
    const gone = fakeKnex({ column: false });
    await migration.down(gone.knex);
    expect(gone.knex.schema.alterTable).not.toHaveBeenCalled();
  });
});
