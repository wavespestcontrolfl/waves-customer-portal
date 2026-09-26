/**
 * 20260925000100 — records the 4x/quarterly T&S retirement in
 * pricing_changelog (idempotently) and purges the already-indexed
 * tree_shrub_quarterly service chunk from knowledge_embeddings (codex r9).
 */
const migration = require('../models/migrations/20260925000100_tree_shrub_quarterly_changelog_and_index_purge');

function fakeKnex(db, tables = ['pricing_changelog', 'knowledge_embeddings']) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async insert(row) { rows().push({ id: rows().length + 1, ...row }); return [row]; },
      async del() {
        const keep = rows().filter((r) => !matches(r));
        const n = rows().length - keep.length;
        db[table] = keep;
        return n;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => tables.includes(t) };
  return knex;
}

describe('20260925000100 T&S quarterly changelog + knowledge-index purge', () => {
  test('inserts one changelog rule row and deletes only the tree_shrub_quarterly service chunks', async () => {
    const db = {
      pricing_changelog: [],
      knowledge_embeddings: [
        { id: 1, source: 'service', source_id: 'tree_shrub_quarterly', chunk_index: 0 },
        { id: 2, source: 'service', source_id: 'tree_shrub_quarterly', chunk_index: 1 },
        { id: 3, source: 'service', source_id: 'tree_shrub_program', chunk_index: 0 },
        { id: 4, source: 'protocol', source_id: 'tree_shrub_quarterly', chunk_index: 0 },
      ],
    };
    await migration.up(fakeKnex(db));
    expect(db.pricing_changelog).toHaveLength(1);
    expect(db.pricing_changelog[0]).toMatchObject({
      ...migration._internals.CHANGELOG_IDENTITY,
      affected_services: JSON.stringify(['tree_shrub']),
    });
    expect(db.knowledge_embeddings.map((r) => r.id)).toEqual([3, 4]);
  });

  test('re-running is a no-op (no duplicate changelog row)', async () => {
    const db = { pricing_changelog: [], knowledge_embeddings: [] };
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));
    expect(db.pricing_changelog).toHaveLength(1);
  });

  test('missing tables are skipped', async () => {
    const db = {};
    await expect(migration.up(fakeKnex(db, []))).resolves.toBeUndefined();
    expect(db).toEqual({});
  });
});
