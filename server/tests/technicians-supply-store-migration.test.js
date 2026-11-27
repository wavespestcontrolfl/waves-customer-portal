/**
 * 20261127130000_technicians_supply_store: additive, nullable text, no seed
 * (no names in the repo), idempotent via hasColumn guards, reversible.
 */
const migration = require('../models/migrations/20261127130000_technicians_supply_store');

function fakeKnex(hasColumn) {
  const calls = [];
  const table = {
    string: jest.fn((name, length) => { calls.push(['string', name, length]); return { nullable: jest.fn(() => calls.push(['nullable'])) }; }),
    dropColumn: jest.fn((name) => calls.push(['dropColumn', name])),
  };
  return {
    calls,
    schema: {
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (name, cb) => { calls.push(['alterTable', name]); cb(table); }),
    },
    raw: jest.fn(),
    insert: jest.fn(),
  };
}

test('up adds one nullable string column and writes no data', async () => {
  const knex = fakeKnex(false);
  await migration.up(knex);
  expect(knex.calls).toEqual([['alterTable', 'technicians'], ['string', 'supply_store', 120], ['nullable']]);
  expect(knex.raw).not.toHaveBeenCalled();
});

test('up is idempotent: a second run with the column present does nothing', async () => {
  const knex = fakeKnex(true);
  await migration.up(knex);
  expect(knex.schema.alterTable).not.toHaveBeenCalled();
});

test('down drops the column only when present', async () => {
  const present = fakeKnex(true);
  await migration.down(present);
  expect(present.calls).toEqual([['alterTable', 'technicians'], ['dropColumn', 'supply_store']]);
  const absent = fakeKnex(false);
  await migration.down(absent);
  expect(absent.schema.alterTable).not.toHaveBeenCalled();
});
