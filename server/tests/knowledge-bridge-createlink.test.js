// Guards createLink's singular FK-pointer discipline: the weekly autoLink
// cron re-runs substring matching, and a broad KB entry can bridge to several
// wiki pages — the knowledge_base.wiki_entry_id / knowledge_entries.kb_entry_id
// pointers must only be written when the entry's link set is unambiguous,
// never overwritten by whichever match happens to be processed last.

jest.mock('../models/db', () => {
  const fn = (table) => global.__bridgeDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const KnowledgeBridge = require('../services/knowledge-bridge');

function makeDb(responses = {}) {
  const state = { responses, calls: {}, inserts: {}, updates: {} };
  const dbFn = (table) => {
    const rec = { table, ops: [] };
    (state.calls[table] = state.calls[table] || []).push(rec);
    const callIdx = state.calls[table].length - 1;
    const resolveRows = () => {
      const conf = state.responses[table];
      if (typeof conf === 'function') return conf(rec, callIdx) || [];
      if (Array.isArray(conf)) return conf;
      return [];
    };
    const b = {};
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'whereIn', 'whereNotNull', 'whereNull', 'orderBy', 'orderByRaw', 'limit', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async () => resolveRows()[0] ?? null;
    b.insert = (row) => {
      (state.inserts[table] = state.inserts[table] || []).push(row);
      const chain = {
        onConflict: () => ({ ignore: () => ({ returning: async () => [{ id: `${table}-1`, ...row }] }) }),
        returning: async () => [{ id: `${table}-1`, ...row }],
      };
      return chain;
    };
    b.update = (patch) => {
      (state.updates[table] = state.updates[table] || []).push(patch);
      return { then: (res, rej) => Promise.resolve(1).then(res, rej) };
    };
    b.then = (res, rej) => Promise.resolve(resolveRows()).then(res, rej);
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

beforeEach(() => jest.clearAllMocks());

const LINK_ARGS = { kbEntryId: 'kb-1', wikiEntryId: 'wiki-a', linkType: 'product_reference', relevanceScore: 0.95, createdBy: 'auto_link' };

test('pointers ARE written when the link set is unambiguous (single pair)', async () => {
  const dbMock = makeDb({
    knowledge_base: (rec) => (rec.ops.some(([m]) => m === 'update') ? [] : [{ slug: 'kb/prod' }]),
    knowledge_entries: [{ slug: 'product/prod' }],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-a' }],
  });
  global.__bridgeDbMock = dbMock;

  await KnowledgeBridge.createLink(LINK_ARGS);

  expect(dbMock.state.updates.knowledge_base).toEqual([{ wiki_entry_id: 'wiki-a' }]);
  expect(dbMock.state.updates.knowledge_entries).toEqual([{ kb_entry_id: 'kb-1' }]);
});

test('pointers are NOT written when the KB entry bridges to multiple wiki pages', async () => {
  const dbMock = makeDb({
    knowledge_base: [{ slug: 'kb/bifen' }],
    knowledge_entries: [{ slug: 'product/bifen-i-t' }],
    // Broad KB entry already linked to two wiki pages — ambiguous
    knowledge_bridge: (rec) => {
      const isKbSide = rec.ops.some(([m, args]) => m === 'where' && args[0]?.kb_entry_id);
      if (isKbSide) {
        return [
          { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-a', kb_slug: null, wiki_slug: null },
          { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-b', kb_slug: null, wiki_slug: null },
        ];
      }
      return [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-a' }];
    },
  });
  global.__bridgeDbMock = dbMock;

  await KnowledgeBridge.createLink(LINK_ARGS);

  // kb-side pointer CLEARED (two distinct wiki targets — a stale arbitrary
  // pointer is worse than null); wiki-side pointer is unambiguous (one
  // distinct kb source) and still writes.
  expect(dbMock.state.updates.knowledge_base).toEqual([{ wiki_entry_id: null }]);
  expect(dbMock.state.updates.knowledge_entries).toEqual([{ kb_entry_id: 'kb-1' }]);
});
