// 20261009140000_property_preferences_new_sod: additive, nullable, idempotent in
// both directions, exact down. A fake schema builder records the calls.
const migration = require('../models/migrations/20261009140000_property_preferences_new_sod');

const COLUMNS = ['sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on'];

function fakeKnex({ hasTable = true, existing = [] } = {}) {
  const calls = [];
  const builder = (kind) => (name, len) => {
    calls.push([kind, name, ...(len ? [len] : [])]);
    return { nullable: () => calls.push(['nullable', name]) };
  };
  const table = {
    date: builder('date'),
    string: builder('string'),
    dropColumn: (name) => calls.push(['dropColumn', name]),
  };
  return {
    calls,
    raw: async (sql) => { calls.push(['raw', sql.replace(/\s+/g, ' ')]); },
    schema: {
      hasTable: async () => hasTable,
      hasColumn: async (_t, column) => existing.includes(column),
      alterTable: async (name, cb) => { calls.push(['alterTable', name]); cb(table); },
    },
  };
}

const DROP_CHECK = ['raw', 'ALTER TABLE property_preferences DROP CONSTRAINT IF EXISTS property_preferences_sod_covers_check'];

describe('property_preferences new-sod record migration', () => {
  test('up adds four nullable columns and a covers CHECK that allows null', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.calls).toEqual([
      ['alterTable', 'property_preferences'],
      ['date', 'sod_laid_on'], ['nullable', 'sod_laid_on'],
      ['string', 'sod_covers', 8], ['nullable', 'sod_covers'],
      ['string', 'sod_area', 120], ['nullable', 'sod_area'],
      ['date', 'sod_rooted_on'], ['nullable', 'sod_rooted_on'],
      DROP_CHECK,
      ['raw', "ALTER TABLE property_preferences ADD CONSTRAINT property_preferences_sod_covers_check CHECK (sod_covers IN ('whole', 'part'))"],
    ]);
  });

  test('up adds only the missing columns', async () => {
    const knex = fakeKnex({ existing: ['sod_laid_on', 'sod_covers'] });
    await migration.up(knex);
    const added = knex.calls.filter(([kind]) => kind === 'date' || kind === 'string').map(([, name]) => name);
    expect(added).toEqual(['sod_area', 'sod_rooted_on']);
  });

  test('up with every column present only re-asserts the CHECK; a missing table is a no-op', async () => {
    const present = fakeKnex({ existing: COLUMNS });
    await migration.up(present);
    expect(present.calls.map(([kind]) => kind)).toEqual(['raw', 'raw']);
    const missing = fakeKnex({ hasTable: false });
    await migration.up(missing);
    expect(missing.calls).toEqual([]);
  });

  test('down drops the CHECK and exactly those columns, only when present', async () => {
    const knex = fakeKnex({ existing: COLUMNS });
    await migration.down(knex);
    expect(knex.calls).toEqual([
      DROP_CHECK,
      ['alterTable', 'property_preferences'],
      ['dropColumn', 'sod_rooted_on'], ['dropColumn', 'sod_area'], ['dropColumn', 'sod_covers'], ['dropColumn', 'sod_laid_on'],
    ]);
    const bare = fakeKnex();
    await migration.down(bare);
    expect(bare.calls).toEqual([DROP_CHECK]);
    const missing = fakeKnex({ hasTable: false });
    await migration.down(missing);
    expect(missing.calls).toEqual([]);
  });
});
