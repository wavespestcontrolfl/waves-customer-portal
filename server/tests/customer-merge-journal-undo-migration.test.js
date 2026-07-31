const migration = require('../models/migrations/20260730600000_customer_merge_journal_undo');

function buildKnex({ hasTable = true, hasColumns = {} } = {}) {
  const state = { added: [], dropped: [] };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async (table, column) => Boolean(hasColumns[column])),
      alterTable: jest.fn(async (table, cb) => {
        expect(table).toBe('customer_merge_journal');
        const nullable = { nullable: jest.fn() };
        cb({
          jsonb: jest.fn((col) => { state.added.push(col); return nullable; }),
          string: jest.fn((col, len) => {
            expect(len).toBe(100);
            state.added.push(col);
            return nullable;
          }),
          dropColumn: jest.fn((col) => state.dropped.push(col)),
        });
      }),
    },
  };
  return { knex, state };
}

describe('customer_merge_journal undo migration', () => {
  test('up adds repointed_ids (jsonb) and undone_by (string), both nullable', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.added).toEqual(['repointed_ids', 'undone_by']);
  });

  test('up is idempotent when the columns already exist', async () => {
    const { knex, state } = buildKnex({ hasColumns: { repointed_ids: true, undone_by: true } });
    await migration.up(knex);
    expect(state.added).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('up no-ops when the journal table does not exist yet', async () => {
    const { knex } = buildKnex({ hasTable: false });
    await migration.up(knex);
    expect(knex.schema.hasColumn).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('down drops both columns symmetrically', async () => {
    const { knex, state } = buildKnex({ hasColumns: { repointed_ids: true, undone_by: true } });
    await migration.down(knex);
    expect(state.dropped).toEqual(['undone_by', 'repointed_ids']);
  });

  test('down tolerates already-missing columns', async () => {
    const { knex, state } = buildKnex({ hasColumns: {} });
    await migration.down(knex);
    expect(state.dropped).toEqual([]);
  });
});
