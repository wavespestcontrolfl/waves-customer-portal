/**
 * 20261023000040_equipment_checks_client_key — adds the nullable client_key
 * column and a partial unique index per truck; down removes both. knex is a
 * recording fake; no Postgres.
 */
const migration = require('../models/migrations/20261023000040_equipment_checks_client_key');

function fakeKnex({ hasColumn = false } = {}) {
  const calls = { alter: [], raw: [] };
  const knex = {};
  knex.schema = {
    hasTable: async () => true,
    hasColumn: async () => hasColumn,
    alterTable: async (table, fn) => fn({ string: (name, len) => { calls.alter.push(['string', name, len]); return { nullable: () => ({}) }; }, dropColumn: (name) => calls.alter.push(['drop', name]) }),
  };
  knex.raw = async (sql) => { calls.raw.push(sql); };
  knex.calls = calls;
  return knex;
}

test('up adds the column once and the partial unique index', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.calls.alter).toEqual([['string', 'client_key', 64]]);
  expect(knex.calls.raw[0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS equipment_checks_vehicle_client_key_idx .* WHERE client_key IS NOT NULL/);
  const again = fakeKnex({ hasColumn: true });
  await migration.up(again);
  expect(again.calls.alter).toEqual([]);
});

test('down drops the index and the column', async () => {
  const knex = fakeKnex({ hasColumn: true });
  await migration.down(knex);
  expect(knex.calls.raw[0]).toMatch(/DROP INDEX IF EXISTS/);
  expect(knex.calls.alter).toEqual([['drop', 'client_key']]);
});
