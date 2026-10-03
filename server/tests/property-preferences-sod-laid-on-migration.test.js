// 20261003173000_property_preferences_sod_laid_on: additive, nullable, idempotent
// in both directions, exact down. A fake schema builder records the calls.
const migration = require('../models/migrations/20261003173000_property_preferences_sod_laid_on');

function fakeKnex({ hasTable = true, hasColumn = false } = {}) {
  const calls = [];
  const table = {
    date: (name) => { calls.push(['date', name]); return { nullable: () => calls.push(['nullable', name]) }; },
    dropColumn: (name) => calls.push(['dropColumn', name]),
  };
  return {
    calls,
    schema: {
      hasTable: async () => hasTable,
      hasColumn: async () => hasColumn,
      alterTable: async (name, cb) => { calls.push(['alterTable', name]); cb(table); },
    },
  };
}

describe('property_preferences.sod_laid_on migration', () => {
  test('up adds one nullable date column', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.calls).toEqual([['alterTable', 'property_preferences'], ['date', 'sod_laid_on'], ['nullable', 'sod_laid_on']]);
  });
  test('up is a no-op when the column exists or the table is missing', async () => {
    for (const opts of [{ hasColumn: true }, { hasTable: false }]) {
      const knex = fakeKnex(opts);
      await migration.up(knex);
      expect(knex.calls).toEqual([]);
    }
  });
  test('down drops exactly that column, and only when present', async () => {
    const present = fakeKnex({ hasColumn: true });
    await migration.down(present);
    expect(present.calls).toEqual([['alterTable', 'property_preferences'], ['dropColumn', 'sod_laid_on']]);
    for (const opts of [{ hasColumn: false }, { hasTable: false }]) {
      const knex = fakeKnex(opts);
      await migration.down(knex);
      expect(knex.calls).toEqual([]);
    }
  });
});
