/**
 * 20260930150000_technicians_bouncie_imei_changed_at: additive, nullable, no
 * backfill (NULL = no known remap = no cutoff), idempotent via hasColumn guards.
 */
const migration = require('../models/migrations/20260930150000_technicians_bouncie_imei_changed_at');

function fakeKnex(hasColumn) {
  const calls = [];
  const table = {
    timestamp: jest.fn((name, opts) => { calls.push(['timestamp', name, opts]); return { nullable: jest.fn(() => calls.push(['nullable'])) }; }),
    dropColumn: jest.fn((name) => calls.push(['dropColumn', name])),
  };
  return {
    calls,
    schema: {
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (name, cb) => { calls.push(['alterTable', name]); cb(table); }),
    },
    raw: jest.fn(),
  };
}

test('up adds a nullable timestamptz column and nothing else (no backfill)', async () => {
  const knex = fakeKnex(false);
  await migration.up(knex);
  expect(knex.calls).toEqual([['alterTable', 'technicians'], ['timestamp', 'bouncie_imei_changed_at', { useTz: true }], ['nullable']]);
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
  expect(present.calls).toEqual([['alterTable', 'technicians'], ['dropColumn', 'bouncie_imei_changed_at']]);
  const absent = fakeKnex(false);
  await migration.down(absent);
  expect(absent.schema.alterTable).not.toHaveBeenCalled();
});
