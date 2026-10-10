const migration = require('../models/migrations/20261008230000_area_addon_visit_scope');

// A fake knex.schema over a set of tables and their columns.
function fakeKnex(tables) {
  const calls = [];
  const schema = {
    hasTable: async (table) => table in tables,
    hasColumn: async (table, column) => (tables[table] || []).includes(column),
    alterTable: async (table, build) => {
      const t = {
        jsonb: (column) => { calls.push(['add', table, column]); tables[table].push(column); return { nullable: () => {} }; },
        dropColumn: (column) => { calls.push(['drop', table, column]); tables[table] = tables[table].filter((c) => c !== column); },
      };
      build(t);
    },
  };
  return { schema, calls, tables };
}

describe('20261008230000 area add-on visit scope', () => {
  test('adds area_addon_scope to both tables, and a second run adds nothing', async () => {
    const knex = fakeKnex({ scheduled_services: ['id'], scheduled_service_addons: ['id'] });
    await migration.up(knex);
    expect(knex.calls).toEqual([['add', 'scheduled_services', 'area_addon_scope'], ['add', 'scheduled_service_addons', 'area_addon_scope']]);
    knex.calls.length = 0;
    await migration.up(knex);
    expect(knex.calls).toEqual([]);
  });

  test('down drops only that column, and only where it exists', async () => {
    const knex = fakeKnex({ scheduled_services: ['id', 'area_addon_scope'], scheduled_service_addons: ['id'] });
    await migration.down(knex);
    expect(knex.calls).toEqual([['drop', 'scheduled_services', 'area_addon_scope']]);
    expect(knex.tables.scheduled_services).toEqual(['id']);
  });

  test('a missing table is skipped, not created', async () => {
    const knex = fakeKnex({ scheduled_services: ['id'] });
    await migration.up(knex);
    expect(knex.calls).toEqual([['add', 'scheduled_services', 'area_addon_scope']]);
  });
});
