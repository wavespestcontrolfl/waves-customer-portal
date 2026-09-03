/**
 * 20260903000030 — seo_link_domains.rejected_by ('owner' | 'bridge'), the
 * marker that lets the authority bridge lift only its OWN rejections.
 */
const migration = require('../models/migrations/20260903000030_link_authority_rejected_by');

function fakeKnex({ hasColumn }) {
  const raws = []; const altered = [];
  const knex = {
    raw: async (sql) => { raws.push(sql); },
    schema: {
      hasColumn: async () => hasColumn,
      alterTable: async (table, cb) => {
        const cols = [];
        cb(new Proxy({}, { get: (_, method) => (...args) => { cols.push({ method, args }); return {}; } }));
        altered.push({ table, cols });
      },
    },
  };
  return { knex, raws, altered };
}

test('up adds the nullable column + the owner|bridge CHECK; idempotent when present', async () => {
  const f = fakeKnex({ hasColumn: false });
  await migration.up(f.knex);
  expect(f.altered).toEqual([{ table: 'seo_link_domains', cols: [{ method: 'string', args: ['rejected_by'] }] }]);
  expect(f.raws).toHaveLength(1);
  expect(f.raws[0]).toMatch(/ADD CONSTRAINT seo_link_domains_rejected_by_check CHECK \(rejected_by IS NULL OR rejected_by IN \('owner', 'bridge'\)\)/);
  const g = fakeKnex({ hasColumn: true });
  await migration.up(g.knex);
  expect(g.altered).toHaveLength(0);
  expect(g.raws).toHaveLength(0);
});

test('down mirrors up', async () => {
  const f = fakeKnex({ hasColumn: true });
  await migration.down(f.knex);
  expect(f.raws[0]).toMatch(/DROP CONSTRAINT IF EXISTS seo_link_domains_rejected_by_check/);
  expect(f.altered).toEqual([{ table: 'seo_link_domains', cols: [{ method: 'dropColumn', args: ['rejected_by'] }] }]);
  const g = fakeKnex({ hasColumn: false });
  await migration.down(g.knex);
  expect(g.raws).toHaveLength(0);
});
