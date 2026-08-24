/**
 * invoices.replaces_invoice_id migration shape (codex #3456): nullable uuid,
 * FK invoices.id ON DELETE SET NULL, partial index; hasColumn-guarded both
 * ways so a re-run is a no-op.
 */
const migration = require('../models/migrations/20260823000010_invoices_replaces_invoice_id');

function fakeKnex({ hasTable = true, hasColumn = false } = {}) {
  const columns = [];
  const builder = {
    uuid: jest.fn((name) => {
      const col = { name, calls: [] };
      columns.push(col);
      const chain = new Proxy({}, { get: (_t, key) => (...args) => { col.calls.push([key, ...args]); return chain; } });
      return chain;
    }),
    dropColumn: jest.fn(),
  };
  const knex = {
    raw: jest.fn(async () => ({})),
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (table, cb) => { cb(builder); }),
    },
  };
  return { knex, builder, columns };
}

describe('20260823000010_invoices_replaces_invoice_id', () => {
  test('up adds a nullable uuid FK to invoices.id ON DELETE SET NULL plus a partial index', async () => {
    const { knex, columns } = fakeKnex();
    await migration.up(knex);
    expect(knex.schema.alterTable).toHaveBeenCalledWith('invoices', expect.any(Function));
    expect(columns).toHaveLength(1);
    expect(columns[0].name).toBe('replaces_invoice_id');
    expect(columns[0].calls).toEqual([
      ['nullable'],
      ['references', 'id'],
      ['inTable', 'invoices'],
      ['onDelete', 'SET NULL'],
    ]);
    expect(knex.raw).toHaveBeenCalledWith(expect.stringMatching(/CREATE INDEX IF NOT EXISTS invoices_replaces_invoice_id_index ON invoices \(replaces_invoice_id\) WHERE replaces_invoice_id IS NOT NULL/));
  });

  test('up is a no-op when the column already exists or the table is absent', async () => {
    const a = fakeKnex({ hasColumn: true });
    await migration.up(a.knex);
    expect(a.knex.schema.alterTable).not.toHaveBeenCalled();
    const b = fakeKnex({ hasTable: false });
    await migration.up(b.knex);
    expect(b.knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('down drops the index then the column, guarded on the column existing', async () => {
    const { knex, builder } = fakeKnex({ hasColumn: true });
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledWith('DROP INDEX IF EXISTS invoices_replaces_invoice_id_index');
    expect(builder.dropColumn).toHaveBeenCalledWith('replaces_invoice_id');
    const none = fakeKnex({ hasColumn: false });
    await migration.down(none.knex);
    expect(none.knex.schema.alterTable).not.toHaveBeenCalled();
  });
});
