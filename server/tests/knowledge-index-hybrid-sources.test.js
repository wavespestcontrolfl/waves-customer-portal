/**
 * hybridKnowledgeSearch `sources` allowlist: a customer-facing reader must
 * never get chunks from corpora outside its list.
 */
const calls = [];
const rows = [
  // ops_rule ranks first in both chunk lists; only the catalog pin lifts species.
  { source: 'ops_rule', source_id: 'r1', title: 'Ops rule', content: 'internal', metadata: {} },
  { source: 'species', source_id: 'ghost-ant', title: 'Ghost Ant', content: 'customer copy', metadata: {} },
];
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const qb = {
      filter: null,
      whereIn(col, vals) { calls.push(['whereIn', col, vals]); qb.filter = vals; return qb; },
      whereNotNull() { return qb; },
      whereRaw() { return qb; },
      select() { return qb; },
      orderBy() { return qb; },
      orderByRaw() { return qb; },
      limit() { return Promise.resolve(qb.filter ? rows.filter((r) => qb.filter.includes(r.source)) : rows); },
    };
    return qb;
  });
  fn.raw = jest.fn(() => 'raw');
  return fn;
});
jest.mock('../services/llm/embed', () => ({ embedQuery: jest.fn(async () => ({ ok: false, reason: 'test' })) }));
jest.mock('../services/knowledge-bridge', () => ({
  unifiedSearch: jest.fn(async () => ({ claudeopedia: [{ slug: 'kb-1', title: 'KB' }], wiki: [{ slug: 'w-1', title: 'Wiki' }] })),
}));

const KnowledgeBridge = require('../services/knowledge-bridge');
const { hybridKnowledgeSearch } = require('../services/knowledge-index/hybrid-search');

beforeEach(() => { calls.length = 0; KnowledgeBridge.unifiedSearch.mockClear(); });

test('no allowlist searches every source', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen');
  expect(results.map((r) => r.source).sort()).toEqual(['kb', 'ops_rule', 'species', 'wiki']);
  expect(calls).toEqual([]);
});

test('allowlist filters chunk lists and drops unlisted kb/wiki', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen', { sources: ['species'] });
  expect(results.map((r) => r.source)).toEqual(['species']);
  expect(calls).toContainEqual(['whereIn', 'source', ['species']]);
  expect(KnowledgeBridge.unifiedSearch).not.toHaveBeenCalled();
});

test('kb in the allowlist keeps the claudeopedia list only', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen', { sources: ['species', 'kb'] });
  expect(results.map((r) => r.source).sort()).toEqual(['kb', 'species']);
});

test('an empty allowlist returns nothing instead of everything', async () => {
  expect(await hybridKnowledgeSearch('ghost ants', { sources: [] })).toEqual({ results: [], usedVector: false });
  expect(await hybridKnowledgeSearch('ghost ants', { sources: ['', null] })).toEqual({ results: [], usedVector: false });
});

test('the named catalog entry is pinned first', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen');
  expect(results[0]).toMatchObject({ source: 'species', sourceId: 'ghost-ant' });
});
