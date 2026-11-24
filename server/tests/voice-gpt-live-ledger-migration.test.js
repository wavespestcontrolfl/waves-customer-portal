/**
 * 20261120020000: the GPT-Live spend ledger. It supersedes voice_gpt_live_spend (whose frozen down() drops its table),
 * and its own down() always refuses, so no rollback, named or batch, gives back billed spend or frees the $5 cap.
 */
const migration = require('../models/migrations/20261120020000_voice_gpt_live_ledger');

function fakeKnex({ hasTable = false } = {}) {
  const columns = [];
  const t = new Proxy({}, {
    get: (_, kind) => (name) => {
      const col = { kind, name, mods: [] };
      columns.push(col);
      const chain = new Proxy({}, { get: (__, mod) => (...args) => { col.mods.push([mod, ...args]); return chain; } });
      return chain;
    },
  });
  const knex = jest.fn();
  knex.fn = { now: () => 'NOW()' };
  knex.schema = {
    hasTable: jest.fn(async () => hasTable),
    createTable: jest.fn(async (name, build) => build(t)),
    dropTableIfExists: jest.fn(async () => {}),
  };
  return { knex, columns };
}

describe('voice_gpt_live_ledger migration', () => {
  test('up() creates the ledger keyed by call_sid, then drops the superseded table', async () => {
    const { knex, columns } = fakeKnex();
    await migration.up(knex);
    expect(knex.schema.createTable).toHaveBeenCalledWith('voice_gpt_live_ledger', expect.any(Function));
    expect(columns.map((c) => c.name)).toEqual(['call_sid', 'reserved_usd', 'cost_usd', 'created_at', 'admitted_at', 'settled_at']);
    expect(columns[0].mods).toContainEqual(['primary']);
    expect(columns[1].mods).toContainEqual(['notNullable']);
    expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith('voice_gpt_live_spend');
  });

  test('up() keeps an existing ledger', async () => {
    const { knex } = fakeKnex({ hasTable: true });
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
  });

  test('down() always refuses and touches nothing: the ledger is permanent', async () => {
    const { knex } = fakeKnex({ hasTable: true });
    await expect(migration.down(knex)).rejects.toThrow(/permanent: roll forward, not back/);
    expect(knex.schema.dropTableIfExists).not.toHaveBeenCalled();
  });
});
