const migration = require('../models/migrations/20261128130000_drop_redundant_notifications_admin_open_idx');

function makeKnex({ hasTable = true, hasDoneAt = true, hasKeysetIdx = true } = {}) {
  const rawCalls = [];
  return {
    rawCalls,
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async () => hasDoneAt),
    },
    raw: jest.fn(async (sql) => {
      rawCalls.push(sql);
      if (/FROM pg_indexes/i.test(sql)) {
        return { rows: hasKeysetIdx ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    }),
  };
}

describe('20261128130000_drop_redundant_notifications_admin_open_idx', () => {
  test('up drops notifications_admin_open_idx when notifications_admin_open_keyset_idx exists', async () => {
    const knex = makeKnex({ hasTable: true, hasKeysetIdx: true });
    await migration.up(knex);
    expect(knex.rawCalls).toEqual([
      expect.stringMatching(/FROM pg_indexes/i),
      'DROP INDEX IF EXISTS notifications_admin_open_idx',
    ]);
  });

  test('up leaves notifications_admin_open_idx intact if the superset keyset index is absent', async () => {
    const knex = makeKnex({ hasTable: true, hasKeysetIdx: false });
    await migration.up(knex);
    expect(knex.rawCalls).toHaveLength(1);
    expect(knex.rawCalls[0]).toMatch(/FROM pg_indexes/i);
  });

  test('down recreates notifications_admin_open_idx when table and done_at exist', async () => {
    const knex = makeKnex({ hasTable: true, hasDoneAt: true });
    await migration.down(knex);
    expect(knex.rawCalls).toHaveLength(1);
    expect(knex.rawCalls[0]).toMatch(/CREATE INDEX IF NOT EXISTS notifications_admin_open_idx/i);
  });
});
