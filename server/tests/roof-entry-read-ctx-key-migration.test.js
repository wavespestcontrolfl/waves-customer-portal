// Shape of the roof_entry_reads context_key migration (20261119160000): the immutable context column, the back-fill, the
// copy index moving from the nullable foreign keys to (source_id, context_key), and a down that restores the previous
// index exactly as the frozen migration made it. A recording stand-in for knex.
const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261119160000_roof_entry_read_ctx_key');

function fakeKnex({ hasContextKey = false } = {}) {
  const calls = { alter: [], raw: [], columns: [] };
  const knex = {
    schema: {
      hasColumn: jest.fn(async () => hasContextKey),
      alterTable: jest.fn(async (table, cb) => {
        const t = {
          string: (name, len) => {
            const r = { type: 'string', name, len };
            calls.columns.push(r);
            const c = { nullable: () => { r.nullable = true; return c; }, notNullable: () => { r.notNullable = true; return c; } };
            return c;
          },
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

describe('roof_entry_read_ctx_key migration', () => {
  it('up adds a nullable varchar(80) context_key, back-fills it, and swaps the copy index to (source_id, context_key)', async () => {
    const { knex, calls } = fakeKnex();
    await migration.up(knex);
    expect(calls.columns).toEqual([{ type: 'string', name: 'context_key', len: 80, nullable: true }]);
    expect(calls.raw).toHaveLength(3);
    expect(calls.raw[0]).toMatch(/^UPDATE roof_entry_reads SET context_key = lower\(COALESCE\(estimate_id::text, ''\)\) \|\| '\|' \|\| lower\(COALESCE\(customer_id::text, ''\)\) WHERE context_key IS NULL$/);
    expect(calls.raw[1]).toBe('DROP INDEX IF EXISTS idx_roof_entry_reads_copy_context');
    expect(calls.raw[2]).toBe('CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_ctx_key ON roof_entry_reads (source_id, context_key) WHERE source_id IS NOT NULL');
  });

  it('up is idempotent: no second column, and every statement is guarded', async () => {
    const { knex, calls } = fakeKnex({ hasContextKey: true });
    await migration.up(knex);
    expect(calls.columns).toEqual([]);
    expect(calls.raw[0]).toMatch(/WHERE context_key IS NULL/);
    expect(calls.raw.slice(1).every((sql) => /IF (NOT )?EXISTS/.test(sql))).toBe(true);
  });

  it('down drops the new index, restores the previous copy index exactly as the frozen migration made it, then drops the column', async () => {
    const { knex, calls } = fakeKnex({ hasContextKey: true });
    await migration.down(knex);
    expect(calls.raw[0]).toBe('DROP INDEX IF EXISTS idx_roof_entry_reads_copy_ctx_key');
    const frozen = fs.readFileSync(path.join(__dirname, '..', 'models', 'migrations', '20261119150000_roof_entry_read_claims.js'), 'utf8');
    // The statement the previous (frozen) migration runs, character for character.
    expect(frozen).toContain(JSON.stringify(calls.raw[1]).slice(1, -1).replace(/\\"/g, '"'));
    expect(calls.raw[1]).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_context ON roof_entry_reads \(source_id, COALESCE\(estimate_id::text, ''\), COALESCE\(customer_id::text, ''\)\) WHERE source_id IS NOT NULL$/);
    expect(calls.alter).toEqual(['alter:roof_entry_reads', 'drop:context_key']);
  });

  it('down is safe to run twice', async () => {
    const { knex, calls } = fakeKnex({ hasContextKey: false });
    await migration.down(knex);
    expect(calls.alter).toEqual([]);
  });
});
