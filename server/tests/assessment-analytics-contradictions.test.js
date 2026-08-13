// Guards the weekly contradiction detector's wiki attribution:
//  - a knowledge_bridge pair (populated by KnowledgeBridge.autoLink in the
//    same Sunday cron) is preferred over the fragmentation-prone slug-ilike
//    fallback for wiki_entry_id
//  - the peak-vs-shoulder rule attributes the bridged wiki entry (it used
//    to insert wiki_entry_id: null, invisible to the review-tier machinery)
//    and mirrors the claim_vs_data gate-now + roll-back-on-failure pattern
//  - without a bridge row, the slug fallback still resolves the wiki page

jest.mock('../models/db', () => {
  const fn = (table) => global.__analyticsDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({})),
  normalizeGrassType: jest.fn((g) => g),
}));
jest.mock('../services/agronomic-wiki', () => ({
  recomputeEntryReviewGate: jest.fn(async () => {}),
}));

const analytics = require('../services/assessment-analytics');
const { recomputeEntryReviewGate } = require('../services/agronomic-wiki');

function makeDb(responses = {}) {
  const state = { responses, calls: {}, inserts: {}, deletes: {} };
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
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.insert = (row) => {
      rec.ops.push(['insert', [row]]);
      (state.inserts[table] = state.inserts[table] || []).push(row);
      return {
        returning: async () => [{ id: `${table}-${(state.inserts[table] || []).length}`, ...row }],
        then: (res, rej) => Promise.resolve([1]).then(res, rej),
      };
    };
    b.del = async () => { state.deletes[table] = (state.deletes[table] || 0) + 1; return 1; };
    b.then = (res, rej) => {
      let rows;
      try { rows = resolveRows(); } catch (err) { return Promise.reject(err).then(res, rej); }
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

const NEGATIVE_EFFICACY = {
  product_name: 'Celsius WG',
  avg_delta_overall: -8,
  application_count: 6,
  peak_stats: null,
  shoulder_stats: null,
  dormant_stats: null,
};

const KB_PRODUCT = { id: 'kb-1', title: 'Product: Celsius WG', content: 'Celsius WG is effective on broadleaf weeds.', slug: 'product/celsius-wg' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('claim_vs_data prefers the bridge pair for wiki attribution over slug match', async () => {
  const dbMock = makeDb({
    product_efficacy: [NEGATIVE_EFFICACY],
    knowledge_base: [KB_PRODUCT],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bridged', wiki_slug: 'product/celsius-wg', relevance_score: 0.95 }],
    // slug fallback would return a DIFFERENT id — must not be consulted
    knowledge_entries: [{ id: 'wiki-slug-match' }],
    knowledge_contradictions: [], // no existing open row
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(1);
  const inserted = dbMock.state.inserts.knowledge_contradictions[0];
  expect(inserted.wiki_entry_id).toBe('wiki-bridged');
  expect(recomputeEntryReviewGate).toHaveBeenCalledWith('wiki-bridged', expect.objectContaining({
    assumeOpenIds: expect.any(Array),
  }));
});

test('with multiple bridge pairs, the exact wiki-slug match for the efficacy product wins', async () => {
  const dbMock = makeDb({
    product_efficacy: [{ ...NEGATIVE_EFFICACY, product_name: 'Bifen XTS' }],
    knowledge_base: [{ ...KB_PRODUCT, title: 'Product: Bifen', content: 'Bifen products are effective.' }],
    // Substring auto-links: one KB entry bridged to two wiki product pages,
    // both at relevance 0.95 — relevance can't disambiguate.
    knowledge_bridge: [
      { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bifen-it', wiki_slug: 'product/bifen-i-t', relevance_score: 0.95 },
      { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bifen-xts', wiki_slug: 'product/bifen-xts', relevance_score: 0.95 },
    ],
    knowledge_entries: [{ id: 'wiki-slug-match' }],
    knowledge_contradictions: [],
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(1);
  // The efficacy row is Bifen XTS → its exact slug pair, not the first row
  expect(dbMock.state.inserts.knowledge_contradictions[0].wiki_entry_id).toBe('wiki-bifen-xts');
});

test('with multiple bridge pairs and no exact slug match, attribution falls back to slug-ilike', async () => {
  const dbMock = makeDb({
    // "Bifen Granular" has no wiki page of its own — no exact slug pair
    product_efficacy: [{ ...NEGATIVE_EFFICACY, product_name: 'Bifen Granular' }],
    knowledge_base: [{ ...KB_PRODUCT, title: 'Product: Bifen', content: 'Bifen products are effective.' }],
    knowledge_bridge: [
      { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bifen-it', wiki_slug: 'product/bifen-i-t', relevance_score: 0.95 },
      { kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bifen-xts', wiki_slug: 'product/bifen-xts', relevance_score: 0.95 },
    ],
    knowledge_entries: [{ id: 'wiki-slug-match' }],
    knowledge_contradictions: [],
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(1);
  // Ambiguous bridge — never guess between pairs; the slug fallback decides.
  expect(dbMock.state.inserts.knowledge_contradictions[0].wiki_entry_id).toBe('wiki-slug-match');
});

test('claim_vs_data falls back to slug match when no bridge pair exists', async () => {
  const dbMock = makeDb({
    product_efficacy: [NEGATIVE_EFFICACY],
    knowledge_base: [KB_PRODUCT],
    knowledge_bridge: [],
    knowledge_entries: [{ id: 'wiki-slug-match' }],
    knowledge_contradictions: [],
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(1);
  expect(dbMock.state.inserts.knowledge_contradictions[0].wiki_entry_id).toBe('wiki-slug-match');
});

test('peak-vs-shoulder rule attributes the bridged wiki entry and gates it', async () => {
  const dbMock = makeDb({
    product_efficacy: [{
      product_name: 'Celsius WG',
      avg_delta_overall: 2, // rule 1 must NOT fire
      application_count: 6,
      peak_stats: JSON.stringify({ count: 6, avgDelta: -5 }),
      shoulder_stats: JSON.stringify({ count: 5, avgDelta: 9 }),
      dormant_stats: null,
    }],
    knowledge_base: [{ ...KB_PRODUCT, content: 'Apply Celsius WG in summer peak season.' }],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bridged', wiki_slug: 'product/celsius-wg', relevance_score: 0.95 }],
    knowledge_entries: [],
    knowledge_contradictions: [],
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(1);
  const inserted = dbMock.state.inserts.knowledge_contradictions[0];
  expect(inserted.contradiction_type).toBe('claim_vs_data');
  expect(inserted.description).toContain('peak season');
  expect(inserted.wiki_entry_id).toBe('wiki-bridged');
  expect(recomputeEntryReviewGate).toHaveBeenCalledWith('wiki-bridged', expect.objectContaining({
    assumeOpenIds: expect.any(Array),
  }));
});

test('an existing open row with null attribution is backfilled and gated when the bridge resolves', async () => {
  const updates = [];
  const dbMock = makeDb({
    product_efficacy: [NEGATIVE_EFFICACY],
    knowledge_base: [KB_PRODUCT],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bridged', wiki_slug: 'product/celsius-wg', relevance_score: 0.95 }],
    knowledge_entries: [],
    // Pre-bridge detector left this open row unattributed — the dedupe skips
    // re-insertion, so without backfill the page stays trusted forever.
    knowledge_contradictions: [{ id: 'contra-legacy', wiki_entry_id: null, status: 'open' }],
  });
  const origDb = dbMock;
  global.__analyticsDbMock = (table) => {
    const b = origDb(table);
    if (table === 'knowledge_contradictions') {
      const origUpdate = b.update;
      b.update = (patch) => { updates.push(patch); return origUpdate ? { then: (res, rej) => Promise.resolve(1).then(res, rej) } : undefined; };
    }
    return b;
  };

  const result = await analytics.detectContradictions();

  expect(result.contradictions).toBe(0); // nothing new inserted
  expect(updates).toEqual([{ wiki_entry_id: 'wiki-bridged' }]);
  expect(recomputeEntryReviewGate).toHaveBeenCalledWith('wiki-bridged', expect.objectContaining({
    assumeOpenIds: ['contra-legacy'],
  }));
});

test('backfill reverts the attribution when the gate recompute fails', async () => {
  recomputeEntryReviewGate.mockRejectedValueOnce(new Error('gate write failed'));
  const updates = [];
  const dbMock = makeDb({
    product_efficacy: [NEGATIVE_EFFICACY],
    knowledge_base: [KB_PRODUCT],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bridged', wiki_slug: 'product/celsius-wg', relevance_score: 0.95 }],
    knowledge_entries: [],
    knowledge_contradictions: [{ id: 'contra-legacy', wiki_entry_id: null, status: 'open' }],
  });
  global.__analyticsDbMock = (table) => {
    const b = dbMock(table);
    if (table === 'knowledge_contradictions') {
      b.update = (patch) => { updates.push(patch); return { then: (res, rej) => Promise.resolve(1).then(res, rej) }; };
    }
    return b;
  };

  const result = await analytics.detectContradictions();

  // The thrown gate error is swallowed by the outer catch; attribution must
  // have been reverted so the next weekly run retries the backfill.
  expect(result.contradictions).toBe(0);
  expect(updates).toEqual([{ wiki_entry_id: 'wiki-bridged' }, { wiki_entry_id: null }]);
});

test('peak-vs-shoulder rolls the insert back when the gate recompute fails', async () => {
  recomputeEntryReviewGate.mockRejectedValueOnce(new Error('gate write failed'));
  const dbMock = makeDb({
    product_efficacy: [{
      product_name: 'Celsius WG',
      avg_delta_overall: 2,
      application_count: 6,
      peak_stats: JSON.stringify({ count: 6, avgDelta: -5 }),
      shoulder_stats: JSON.stringify({ count: 5, avgDelta: 9 }),
      dormant_stats: null,
    }],
    knowledge_base: [{ ...KB_PRODUCT, content: 'Apply Celsius WG in summer peak season.' }],
    knowledge_bridge: [{ kb_entry_id: 'kb-1', wiki_entry_id: 'wiki-bridged', wiki_slug: 'product/celsius-wg', relevance_score: 0.95 }],
    knowledge_entries: [],
    knowledge_contradictions: [],
  });
  global.__analyticsDbMock = dbMock;

  const result = await analytics.detectContradictions();

  // The thrown gate error is caught by the outer detectContradictions catch;
  // the inserted row must have been deleted so the dedupe can't strand it.
  expect(result.contradictions).toBe(0);
  expect(dbMock.state.deletes.knowledge_contradictions).toBe(1);
});
