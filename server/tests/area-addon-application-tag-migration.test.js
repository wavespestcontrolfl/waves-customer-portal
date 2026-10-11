const migration = require('../models/migrations/20261009200000_area_addon_application_tag');

// A fake knex.schema over a set of tables and their columns.
function fakeKnex(tables) {
  const calls = [];
  const schema = {
    hasTable: async (table) => table in tables,
    hasColumn: async (table, column) => (tables[table] || []).includes(column),
    alterTable: async (table, build) => {
      const t = {
        string: (column, length) => { calls.push(['add', table, column, length]); tables[table].push(column); return { nullable: () => {} }; },
        dropColumn: (column) => { calls.push(['drop', table, column]); tables[table] = tables[table].filter((c) => c !== column); },
      };
      build(t);
    },
  };
  return { schema, calls, tables };
}

describe('20261009200000 area add-on application tag', () => {
  test('adds a nullable service_products.area_addon_key, and a second run adds nothing', async () => {
    const knex = fakeKnex({ service_products: ['id'] });
    await migration.up(knex);
    expect(knex.calls).toEqual([['add', 'service_products', 'area_addon_key', 80]]);
    knex.calls.length = 0;
    await migration.up(knex);
    expect(knex.calls).toEqual([]);
  });

  test('down drops only that column, and only where it exists', async () => {
    const knex = fakeKnex({ service_products: ['id', 'area_addon_key'] });
    await migration.down(knex);
    expect(knex.calls).toEqual([['drop', 'service_products', 'area_addon_key']]);
    expect(knex.tables.service_products).toEqual(['id']);
    knex.calls.length = 0;
    await migration.down(knex);
    expect(knex.calls).toEqual([]);
  });

  test('a missing table is skipped, not created', async () => {
    const knex = fakeKnex({});
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.calls).toEqual([]);
  });
});
