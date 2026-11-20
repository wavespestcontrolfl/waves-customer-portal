// Shape of the roof_entry_reads claim migration (20261119150000): the columns, the partial unique index that allows one
// pending claim per crop, an idempotent up, and a down that undoes exactly what up added. A recording stand-in for knex.
const migration = require('../models/migrations/20261119150000_roof_entry_read_claims');

function fakeKnex({ hasStatus = false } = {}) {
  const calls = { alter: [], raw: [], columns: [] };
  const chain = (record) => {
    const c = { notNullable: () => { record.notNullable = true; return c; }, nullable: () => { record.nullable = true; return c; }, defaultTo: (v) => { record.default = v; return c; } };
    return c;
  };
  const knex = {
    schema: {
      hasColumn: jest.fn(async () => hasStatus),
      alterTable: jest.fn(async (table, cb) => {
        const t = {
          string: (name, len) => { const r = { type: 'string', name, len }; calls.columns.push(r); return chain(r); },
          timestamp: (name, opts) => { const r = { type: 'timestamp', name, opts }; calls.columns.push(r); return chain(r); },
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
  it('up adds status varchar(16) not null default done, a nullable timestamptz claimed_at and the one-pending-per-crop index', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.columns).toEqual([
      { type: 'string', name: 'status', len: 16, notNullable: true, default: 'done' },
      { type: 'timestamp', name: 'claimed_at', opts: { useTz: true }, nullable: true },
    ]);
    expect(calls.raw).toHaveLength(1);
    expect(calls.raw[0]).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_pending_key ON roof_entry_reads \(lookup_key\) WHERE status = 'pending'/);
  });

  it('up is idempotent: it adds no column that already exists', async () => {
    const { knex, calls } = fakeKnex({ hasStatus: true });
    await migration.up(knex);
    expect(calls.columns).toEqual([]);
    expect(calls.raw[0]).toMatch(/IF NOT EXISTS/);
  });

  it('down drops the index first, then both columns', async () => {
    const { knex, calls } = fakeKnex({ hasStatus: true });
    await migration.down(knex);
    expect(calls.raw).toEqual(['DROP INDEX IF EXISTS idx_roof_entry_reads_pending_key']);
    expect(calls.alter).toEqual(['alter:roof_entry_reads', 'drop:status', 'drop:claimed_at']);
  });

  it('down is safe to run twice', async () => {
    const { knex, calls } = fakeKnex({ hasStatus: false });
    await migration.down(knex);
    expect(calls.alter).toEqual([]);
  });

  it('leaves the frozen first migration alone', () => {
    const first = require('../models/migrations/20261119140000_roof_entry_reads');
    expect(typeof first.up).toBe('function');
    expect(migration.up).not.toBe(first.up);
  });
});
