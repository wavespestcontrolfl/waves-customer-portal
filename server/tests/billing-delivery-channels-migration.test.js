const migration = require('../models/migrations/20260924010200_billing_delivery_channels');

function harness() {
  const columns = new Set();
  const constraints = new Set();
  const types = new Map();
  const knex = {
    schema: {
      hasTable: jest.fn(async () => true),
      hasColumn: jest.fn(async (_table, column) => columns.has(column)),
      alterTable: jest.fn(async (_table, callback) => callback({
        specificType(column, type) {
          columns.add(column);
          types.set(column, type);
          return { nullable: jest.fn() };
        },
        dropColumn(column) { columns.delete(column); },
      })),
    },
    raw: jest.fn(async (sql, bindings) => {
      if (sql.startsWith('SELECT 1')) return { rows: constraints.has(bindings[0]) ? [{}] : [] };
      const match = sql.match(/ADD CONSTRAINT (notification_prefs_\w+_check)/);
      if (match) constraints.add(match[1]);
      return { rows: [] };
    }),
  };
  return { knex, columns, constraints, types };
}

describe('billing delivery channel migration', () => {
  test('up adds nullable text arrays with nonempty, allowed-value, and uniqueness checks', async () => {
    const { knex, columns, constraints, types } = harness();
    await migration.up(knex);
    expect([...columns]).toEqual(migration._private.COLUMNS);
    expect([...types.values()]).toEqual(['text[]', 'text[]', 'text[]', 'text[]']);
    expect(constraints.size).toBe(4);
    const sql = knex.raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('cardinality(invoice_channels) BETWEEN 1 AND 3');
    expect(sql).toContain("invoice_channels <@ ARRAY['email', 'sms', 'push']::text[]");
    expect(sql).toContain("('push' = ANY(invoice_channels))::int");
  });

  test('up is idempotent and down removes all four columns', async () => {
    const { knex, columns } = harness();
    await migration.up(knex);
    const altersAfterFirstUp = knex.schema.alterTable.mock.calls.length;
    await migration.up(knex);
    expect(knex.schema.alterTable).toHaveBeenCalledTimes(altersAfterFirstUp);
    await migration.down(knex);
    expect(columns.size).toBe(0);
    await migration.down(knex);
    expect(columns.size).toBe(0);
  });

  test('up and down no-op when notification_prefs is absent', async () => {
    const { knex } = harness();
    knex.schema.hasTable.mockResolvedValue(false);
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex.raw).not.toHaveBeenCalled();
  });
});
