/**
 * 20261122190000_newsletter_reader_confirmed: adds the two reader-confirm columns to
 * newsletter_subscribers, idempotently (hasColumn guards), with no backfill; down drops them.
 * A fake knex records the schema calls: no database.
 */
const migration = require('../models/migrations/20261122190000_newsletter_reader_confirmed');

function fakeKnex({ table = true, columns = [] } = {}) {
  const have = new Set(columns);
  const added = [];
  const dropped = [];
  const raws = [];
  const builder = {
    timestamp: (name, opts) => { added.push({ name, type: 'timestamp', opts }); have.add(name); return { nullable: () => {} }; },
    text: (name) => { added.push({ name, type: 'text' }); have.add(name); return { nullable: () => {} }; },
    dropColumn: (name) => { dropped.push(name); have.delete(name); },
  };
  const knex = {
    schema: {
      hasTable: async () => table,
      hasColumn: async (_t, c) => have.has(c),
      alterTable: async (_t, fn) => fn(builder),
    },
    raw: async (sql) => { raws.push(sql); },
  };
  return { knex, added, dropped, raws };
}

describe('newsletter reader-confirmed columns migration', () => {
  test('up adds both nullable columns (timestamptz and text) and writes no row', async () => {
    const { knex, added, raws } = fakeKnex();
    await migration.up(knex);
    expect(added).toEqual([
      { name: 'reader_confirmed_at', type: 'timestamp', opts: { useTz: true } },
      { name: 'reader_confirmed_email', type: 'text' },
    ]);
    // No backfill: history cannot tell a reader's click from a trusted add.
    expect(raws).toEqual([]);
  });

  test('up is idempotent: existing columns are left alone, and a missing table is skipped', async () => {
    const both = fakeKnex({ columns: ['reader_confirmed_at', 'reader_confirmed_email'] });
    await migration.up(both.knex);
    expect(both.added).toEqual([]);
    const one = fakeKnex({ columns: ['reader_confirmed_at'] });
    await migration.up(one.knex);
    expect(one.added.map((a) => a.name)).toEqual(['reader_confirmed_email']);
    const none = fakeKnex({ table: false });
    await migration.up(none.knex);
    expect(none.added).toEqual([]);
  });

  test('down drops both columns, and only the ones that exist', async () => {
    const both = fakeKnex({ columns: ['reader_confirmed_at', 'reader_confirmed_email'] });
    await migration.down(both.knex);
    expect(both.dropped).toEqual(['reader_confirmed_at', 'reader_confirmed_email']);
    const none = fakeKnex();
    await migration.down(none.knex);
    expect(none.dropped).toEqual([]);
  });
});
