/**
 * hybridKnowledgeSearch: the `sources` allowlist (a customer-facing reader
 * must never get chunks from corpora outside its list) and the catalog-first
 * pin (the named entry leads, fetched by key when no list surfaced it).
 */
const mockCalls = [];
let mockChunkRows = [];
let mockPinnedRows = [];

jest.mock('../models/db', () => {
  const chain = () => {
    const qb = {
      filter: null,
      pinLookups: [],
      inner: null,
      whereIn(col, vals) { mockCalls.push(['whereIn', col, vals]); qb.filter = vals; return qb; },
      where(arg, ...rest) {
        if (typeof arg === 'function') {
          const sub = { orWhere(o) { qb.pinLookups.push(o); return sub; } };
          arg(sub);
        } else if (arg === 'chunk_index') qb.pinRead = true;
        return qb;
      },
      from(inner) { qb.inner = inner; return qb; },
      as() { return qb; },
      whereNotNull() { return qb; },
      whereRaw() { return qb; },
      select() { return qb; },
      orderBy() { return qb; },
      limit() { return qb; },
      then(resolve, reject) {
        let rows;
        if (qb.pinRead) {
          rows = mockPinnedRows.filter((r) => qb.pinLookups.some((o) => o.source === r.source && o.source_id === r.source_id));
        } else {
          const filter = qb.inner ? qb.inner.filter : qb.filter;
          rows = filter ? mockChunkRows.filter((r) => filter.includes(r.source)) : mockChunkRows;
        }
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return qb;
  };
  const fn = jest.fn(() => chain());
  fn.select = jest.fn(() => chain());
  fn.raw = jest.fn(() => 'raw');
  return fn;
});
jest.mock('../services/llm/embed', () => ({ embedQuery: jest.fn(async () => ({ ok: false, reason: 'test' })) }));
jest.mock('../services/knowledge-bridge', () => ({
  unifiedSearch: jest.fn(async () => ({ claudeopedia: [{ slug: 'kb-1', title: 'KB' }], wiki: [{ slug: 'w-1', title: 'Wiki' }] })),
}));

const KnowledgeBridge = require('../services/knowledge-bridge');
const { hybridKnowledgeSearch } = require('../services/knowledge-index/hybrid-search');

const row = (source, sourceId) => ({ source, source_id: sourceId, title: sourceId, content: `${source} text`, metadata: {} });

beforeEach(() => {
  mockCalls.length = 0;
  KnowledgeBridge.unifiedSearch.mockClear();
  // ops_rule ranks first in the chunk list; only the catalog pin lifts species.
  mockChunkRows = [row('ops_rule', 'r1'), row('species', 'ghost-ant')];
  mockPinnedRows = [row('species', 'large-patch'), row('species_tech', 'large-patch')];
});

test('no allowlist searches every source', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen');
  expect(results.map((r) => r.source).sort()).toEqual(['kb', 'ops_rule', 'species', 'wiki']);
  expect(mockCalls).toEqual([]);
});

test('allowlist filters chunk lists and drops unlisted kb/wiki', async () => {
  const { results } = await hybridKnowledgeSearch('ghost ants in kitchen', { sources: ['species'] });
  expect(results.map((r) => r.source)).toEqual(['species']);
  expect(mockCalls).toContainEqual(['whereIn', 'source', ['species']]);
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

test('a named entry no list surfaced is fetched by key and leads', async () => {
  const { results } = await hybridKnowledgeSearch('what do I spray for large patch in October');
  expect(results.slice(0, 2).map((r) => `${r.source}:${r.sourceId}`)).toEqual(['species:large-patch', 'species_tech:large-patch']);
});

test('the pin fetch honours the allowlist', async () => {
  const { results } = await hybridKnowledgeSearch('large patch in October', { sources: ['species'] });
  expect(results.map((r) => `${r.source}:${r.sourceId}`)).toEqual(['species:large-patch', 'species:ghost-ant']);
});
