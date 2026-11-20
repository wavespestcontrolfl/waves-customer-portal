// Shape of the roof_entry_reads claim migration (20261119150000): the columns, the two partial unique indexes (one pending
// claim per crop, one copy per source and context), an idempotent up, and a down that undoes exactly what up added.
// A recording stand-in for knex.
const migration = require('../models/migrations/20261119150000_roof_entry_read_claims');

function fakeKnex({ has = {} } = {}) {
  const calls = { alter: [], raw: [], columns: [] };
  const chain = (record) => {
    const c = {
      notNullable: () => { record.notNullable = true; return c; },
      nullable: () => { record.nullable = true; return c; },
      defaultTo: (v) => { record.default = v; return c; },
      references: (col) => { record.references = col; return c; },
      inTable: (t) => { record.inTable = t; return c; },
      onDelete: (a) => { record.onDelete = a; return c; },
    };
    return c;
  };
  const knex = {
    schema: {
      hasColumn: jest.fn(async (_table, col) => !!has[col]),
      alterTable: jest.fn(async (table, cb) => {
        const t = {
          string: (name, len) => { const r = { type: 'string', name, len }; calls.columns.push(r); return chain(r); },
          timestamp: (name, opts) => { const r = { type: 'timestamp', name, opts }; calls.columns.push(r); return chain(r); },
          uuid: (name) => { const r = { type: 'uuid', name }; calls.columns.push(r); return chain(r); },
          dropColumn: (name) => calls.alter.push(`drop:${name}`),
        };
        calls.alter.push(`alter:${table}`);
        cb(t);
      }),
    },
    raw: jest.fn(async (sql) => { calls.raw.push(sql); }),
  };
  return { knex, calls };
}

describe('roof_entry_read_claims migration', () => {
  it('up adds status, claimed_at and a null-on-delete source_id', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.columns).toEqual([
      { type: 'string', name: 'status', len: 16, notNullable: true, default: 'done' },
      { type: 'timestamp', name: 'claimed_at', opts: { useTz: true }, nullable: true },
      { type: 'uuid', name: 'source_id', nullable: true, references: 'id', inTable: 'roof_entry_reads', onDelete: 'SET NULL' },
    ]);
  });

  it('up creates one pending claim per crop and one copy per source and context', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.raw).toHaveLength(2);
    expect(calls.raw[0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_pending_key ON roof_entry_reads \(lookup_key\) WHERE status = 'pending'/);
    expect(calls.raw[1]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_context ON roof_entry_reads \(source_id, COALESCE\(estimate_id::text, ''\), COALESCE\(customer_id::text, ''\)\) WHERE source_id IS NOT NULL/);
  });

  it('up is idempotent: it adds no column that already exists', async () => {
    const { knex, calls } = fakeKnex({ has: { status: true, source_id: true } });
    await migration.up(knex);
    expect(calls.columns).toEqual([]);
    expect(calls.raw.every((sql) => /IF NOT EXISTS/.test(sql))).toBe(true);
  });

  it('down drops both indexes first, then source_id, status and claimed_at', async () => {
    const { knex, calls } = fakeKnex({ has: { status: true, source_id: true } });
    await migration.down(knex);
    expect(calls.raw).toEqual([
      'DROP INDEX IF EXISTS idx_roof_entry_reads_copy_context',
      'DROP INDEX IF EXISTS idx_roof_entry_reads_pending_key',
    ]);
    expect(calls.alter).toEqual(['alter:roof_entry_reads', 'drop:source_id', 'alter:roof_entry_reads', 'drop:status', 'drop:claimed_at']);
  });

  it('down is safe to run twice', async () => {
    const { knex, calls } = fakeKnex();
    await migration.down(knex);
    expect(calls.alter).toEqual([]);
  });

  it('leaves the frozen first migration alone', () => {
    const first = require('../models/migrations/20261119140000_roof_entry_reads');
    expect(typeof first.up).toBe('function');
    expect(migration.up).not.toBe(first.up);
  });
});
