const migration = require('../models/migrations/20260530000021_lawn_service_outline_system');

function makeKnexWithExistingOutlineTables() {
  const tableCalls = [];
  const queryBuilder = {
    insert: jest.fn(() => ({
      onConflict: jest.fn(() => ({
        ignore: jest.fn(async () => undefined),
      })),
    })),
  };

  const knex = jest.fn((table) => {
    tableCalls.push(table);
    return queryBuilder;
  });

  knex.fn = { now: jest.fn(() => 'NOW') };
  knex.raw = jest.fn((sql) => sql);
  knex.schema = {
    hasTable: jest.fn(async (table) => table !== 'products_catalog'),
    createTable: jest.fn(async () => undefined),
    hasColumn: jest.fn(async () => true),
    alterTable: jest.fn(async () => undefined),
  };
  knex.tableCalls = tableCalls;
  return knex;
}

describe('lawn service outline schema migration', () => {
  test('does not recreate outline tables that already exist', async () => {
    const knex = makeKnexWithExistingOutlineTables();

    await migration.up(knex);

    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex.tableCalls).toEqual(expect.arrayContaining([
      'lawn_service_content_modules',
      'jurisdiction_fertilizer_rules',
    ]));
  });
});
