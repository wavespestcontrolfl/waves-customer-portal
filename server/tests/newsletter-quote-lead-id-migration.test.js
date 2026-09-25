const migration = require('../models/migrations/20260924020300_newsletter_quote_lead_id');

function makeKnex({ hasTable = true, hasColumn = false } = {}) {
  const alters = [];
  const knex = {
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (table, cb) => {
        const t = { uuid: jest.fn(() => ({ nullable: jest.fn() })), dropColumn: jest.fn() };
        cb(t); alters.push({ table, t });
      }),
    },
  };
  return { knex, alters };
}

describe('newsletter_subscribers.quote_lead_id migration', () => {
  test('adds a nullable uuid column once', async () => {
    const { knex, alters } = makeKnex();
    await migration.up(knex);
    expect(alters).toHaveLength(1);
    expect(alters[0].t.uuid).toHaveBeenCalledWith('quote_lead_id');
  });
  test('idempotent when the column exists', async () => {
    const { knex, alters } = makeKnex({ hasColumn: true });
    await migration.up(knex);
    expect(alters).toHaveLength(0);
  });
  test('no table → no-op', async () => {
    const { knex, alters } = makeKnex({ hasTable: false });
    await migration.up(knex);
    expect(alters).toHaveLength(0);
  });
  test('down drops the column only when present', async () => {
    const a = makeKnex({ hasColumn: true }); await migration.down(a.knex);
    expect(a.alters[0].t.dropColumn).toHaveBeenCalledWith('quote_lead_id');
    const b = makeKnex({ hasColumn: false }); await migration.down(b.knex);
    expect(b.alters).toHaveLength(0);
  });
});
