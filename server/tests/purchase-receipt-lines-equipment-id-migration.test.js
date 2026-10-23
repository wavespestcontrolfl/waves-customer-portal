/**
 * 20261023180000_purchase_receipt_lines_equipment_id — adds the nullable
 * equipment_id column (FK to equipment, SET NULL) once; down drops it.
 * knex is a recording fake; no Postgres.
 */
const migration = require('../models/migrations/20261023180000_purchase_receipt_lines_equipment_id');

function fakeKnex({ hasColumn = false } = {}) {
  const calls = [];
  const col = { nullable: () => col, references: (c) => { calls.push(['references', c]); return col; }, inTable: (t) => { calls.push(['inTable', t]); return col; }, onDelete: (m) => { calls.push(['onDelete', m]); return col; } };
  return {
    calls,
    schema: {
      hasTable: async () => true,
      hasColumn: async () => hasColumn,
      alterTable: async (table, fn) => fn({
        uuid: (name) => { calls.push(['uuid', name]); return col; },
        index: (name) => calls.push(['index', name]),
        dropColumn: (name) => calls.push(['drop', name]),
      }),
    },
  };
}

test('up adds the column once with its FK and index', async () => {
  const knex = fakeKnex();
  await migration.up(knex);
  expect(knex.calls).toEqual([['uuid', 'equipment_id'], ['references', 'id'], ['inTable', 'equipment'], ['onDelete', 'SET NULL'], ['index', 'equipment_id']]);
  const again = fakeKnex({ hasColumn: true });
  await migration.up(again);
  expect(again.calls).toEqual([]);
});

test('down drops the column only when present', async () => {
  const knex = fakeKnex({ hasColumn: true });
  await migration.down(knex);
  expect(knex.calls).toEqual([['drop', 'equipment_id']]);
  const none = fakeKnex();
  await migration.down(none);
  expect(none.calls).toEqual([]);
});
