// Shape of the roof_entry_reads rollback-guard migration (20261119170000): a no-op up, and a down that only detaches
// colliding copies (UPDATE, never DELETE). The behaviour is proven on PostgreSQL in roof-entry-read-migrations-postgres.test.js.
const fs = require('fs');
const path = require('path');
const migration = require('../models/migrations/20261119170000_roof_entry_read_rollback_guard');

describe('roof_entry_read_rollback_guard migration', () => {
  it('up does nothing', async () => {
    const knex = { raw: jest.fn(), schema: {} };
    await migration.up(knex);
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it('down runs one UPDATE that clears source_id on a later duplicate, as the old copy index reads the keys, and deletes nothing', async () => {
    const knex = { raw: jest.fn(async () => {}) };
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const sql = knex.raw.mock.calls[0][0].replace(/\s+/g, ' ').trim();
    expect(sql).toMatch(/^UPDATE roof_entry_reads r SET source_id = NULL WHERE r\.source_id IS NOT NULL AND EXISTS \(/);
    expect(sql).toContain('o.source_id = r.source_id');
    expect(sql).toContain('o.id < r.id');
    expect(sql).toContain("COALESCE(o.estimate_id::text, '') = COALESCE(r.estimate_id::text, '')");
    expect(sql).toContain("COALESCE(o.customer_id::text, '') = COALESCE(r.customer_id::text, '')");
    expect(sql).not.toMatch(/DELETE|DROP|TRUNCATE/i);
  });

  it('sorts after the frozen 160000 migration, so a batch rollback runs it first', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((f) => f.startsWith('20261119')).sort();
    expect(files.indexOf('20261119170000_roof_entry_read_rollback_guard.js')).toBeGreaterThan(files.indexOf('20261119160000_roof_entry_read_ctx_key.js'));
  });
});
