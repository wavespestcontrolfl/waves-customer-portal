// Guards phases D+E of the agronomic-brain program:
//  - syncToClaudeopedia only moves TRUSTED wiki pages (auto/approved) with
//    real content into the knowledge base
//  - syncToClaudeopediaIfDue enforces weekly cadence from a daily cron and
//    logs success/failure rows (self-healing, diagnosable)
//  - the Intelligence Bar search_field_intelligence tool queries the brain
//    trusted-only and surfaces open contradictions

jest.mock('../models/db', () => {
  const fn = (table) => global.__syncDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model', WORKHORSE: 'test-model', FAST: 'test-model' }));
jest.mock('../services/lawn-grass-context', () => ({
  loadCustomerGrassContext: jest.fn(async () => ({})),
  irrigationTypeHasSystem: jest.fn(() => null),
}));
jest.mock('@anthropic-ai/sdk', () => class MockAnthropic {
  constructor() { this.messages = { create: jest.fn() }; }
});
// knowledge-bridge pulls the llm dispatcher for its Q&A path — not under test
jest.mock('../services/llm/call', () => ({ callLlm: jest.fn() }), { virtual: true });

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
    for (const m of ['where', 'andWhere', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereIn', 'orWhereIn', 'whereNotIn', 'whereNotNull', 'orderBy', 'orderByRaw', 'limit', 'offset', 'select', 'groupBy']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.count = (...args) => { rec.ops.push(['count', args]); return b; };
    b.insert = (row) => {
      rec.ops.push(['insert', [row]]);
      (state.inserts[table] = state.inserts[table] || []).push(row);
      return {
        returning: async () => [{ id: `${table}-${(state.inserts[table] || []).length}`, ...row }],
        then: (res, rej) => Promise.resolve([1]).then(res, rej),
      };
    };
    b.update = (patch) => {
      rec.ops.push(['update', [patch]]);
      (state.updates[table] = state.updates[table] || []).push(patch);
      return {
        returning: async () => [{ ...(resolveRows()[0] || {}), ...patch }],
        then: (res, rej) => Promise.resolve(1).then(res, rej),
      };
    };
    b.del = async () => 1;
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

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__syncDbMock = dbFn;
  return dbFn.state;
}

const KnowledgeBridge = require('../services/knowledge-bridge');

describe('syncToClaudeopedia trust gate', () => {
  test('source query filters to trusted statuses and skips stub content', async () => {
    const state = useDb({
      knowledge_entries: (rec, idx) => (idx === 0 ? [
        { id: 'w1', slug: 'product/talstar-p', title: 'Product: Talstar P', category: 'product', summary: 's', data_point_count: 9, confidence: 'moderate', content: '# Real content' },
        { id: 'w2', slug: 'product/stub', title: 'Product: Stub', category: 'product', summary: null, data_point_count: 1, confidence: 'low', content: '# T\n\n*Pending AI generation — 1 data points available.*' },
      ] : []),
      knowledge_base: [],
      knowledge_bridge: [],
    });

    const stats = await KnowledgeBridge.syncToClaudeopedia();

    const sourceQuery = state.calls.knowledge_entries[0];
    const trusted = sourceQuery.ops.find(([m, a]) => m === 'whereIn' && a[0] === 'review_status');
    expect(trusted[1][1]).toEqual(['auto', 'approved']);
    // only the real-content page synced; the stub was skipped
    expect(stats.created).toBe(1);
    expect((state.inserts.knowledge_base || []).map((r) => r.slug)).toEqual(['outcomes-product-talstar-p']);
  });

  test('a top-level sync failure counts as an error so the guard retries next day', async () => {
    // knowledge_entries source query dies before the loop — the run must
    // NOT come back errors:0, or the ifDue wrapper writes a kb_sync success
    // marker and suppresses retries for six days with nothing synced.
    useDb({ knowledge_entries: () => { throw new Error('relation unavailable'); } });

    const stats = await KnowledgeBridge.syncToClaudeopedia();

    expect(stats.errors).toBeGreaterThanOrEqual(1);
    expect(stats.created).toBe(0);
  });

  test('a failed reconciliation pass counts as a sync error so the guard retries next day', async () => {
    const inner = makeDb({ knowledge_entries: [], knowledge_base: [] });
    global.__syncDbMock = (table) => {
      const b = inner(table);
      if (table === 'knowledge_base') {
        b.update = () => ({ then: (res, rej) => Promise.reject(new Error('db down')).then(res, rej) });
      }
      return b;
    };

    const stats = await KnowledgeBridge.syncToClaudeopedia();

    // errors > 0 → syncToClaudeopediaIfDue logs kb_sync_error, which the
    // six-day guard ignores — the healing pass retries tomorrow
    expect(stats.errors).toBe(1);
  });

  test('sync reconciles copies of no-longer-trusted pages to flagged', async () => {
    const state = useDb({ knowledge_entries: [], knowledge_base: [] });

    await KnowledgeBridge.syncToClaudeopedia();

    // the reconciliation pass flags wiki-sync copies whose source page is untrusted
    const reconcile = (state.updates.knowledge_base || []).find((u) => u.status === 'flagged');
    expect(reconcile).toBeTruthy();
    const kbCalls = state.calls.knowledge_base;
    const reconcileCall = kbCalls.find((rec) => rec.ops.some(([m, a]) => m === 'where' && a[0]?.source === 'wiki-sync'));
    expect(reconcileCall).toBeTruthy();
  });
});

describe('syncToClaudeopediaIfDue', () => {
  test('skips when a kb_sync ran in the last 6 days', async () => {
    useDb({ knowledge_update_log: [{ id: 'log-1' }] });
    const result = await KnowledgeBridge.syncToClaudeopediaIfDue();
    expect(result).toEqual({ skipped: true });
  });

  test('runs the sync and logs a kb_sync row when due', async () => {
    const state = useDb({ knowledge_update_log: [], knowledge_entries: [], knowledge_base: [] });
    const spy = jest.spyOn(KnowledgeBridge, 'syncToClaudeopedia').mockResolvedValue({ created: 2, updated: 1, errors: 0 });

    const result = await KnowledgeBridge.syncToClaudeopediaIfDue();

    expect(result).toEqual({ created: 2, updated: 1, errors: 0 });
    const log = (state.inserts.knowledge_update_log || [])[0];
    expect(log.trigger_type).toBe('kb_sync');
    expect(log.action).toBe('sync');
    spy.mockRestore();
  });

  test('a sync with errors logs kb_sync_error so the next day retries', async () => {
    const state = useDb({ knowledge_update_log: [] });
    const spy = jest.spyOn(KnowledgeBridge, 'syncToClaudeopedia').mockResolvedValue({ created: 0, updated: 0, errors: 3 });

    await KnowledgeBridge.syncToClaudeopediaIfDue();

    expect((state.inserts.knowledge_update_log || [])[0].trigger_type).toBe('kb_sync_error');
    spy.mockRestore();
  });
});

describe('IB search_field_intelligence', () => {
  test('queries the brain trusted-only and returns sources + contradictions', async () => {
    const state = useDb({
      knowledge_entries: [{ id: 'w1', summary: 'K-Flow summary' }],
      knowledge_base: [{ id: 'kb1', content: 'KB content about potassium' }],
      knowledge_contradictions: [{ contradiction_type: 'claim_vs_data', description: 'Label says X, field shows Y', severity: 0.7, status: 'open' }],
    });
    const spy = jest.spyOn(KnowledgeBridge, 'unifiedSearch').mockResolvedValue({
      claudeopedia: [{ id: 'kb1', slug: 'k-flow', title: 'K-Flow', category: 'chemicals', confidence: 'high' }],
      wiki: [{ id: 'w1', slug: 'product/lesco-k-flow-0-0-25', title: 'Product: LESCO K-Flow 0-0-25', category: 'product', confidence: 'moderate', data_point_count: 10, review_tier: 'yellow' }],
      bridged: [{}],
    });

    const { executeTool } = require('../services/intelligence-bar/tools');
    const result = await executeTool('search_field_intelligence', { query: 'k-flow' });

    expect(spy).toHaveBeenCalledWith('k-flow', { limit: 6, trustedOnly: true });
    expect(result.fieldIntelligence[0]).toMatchObject({
      slug: 'product/lesco-k-flow-0-0-25',
      dataPoints: 10,
      tier: 'yellow',
      summary: 'K-Flow summary',
    });
    expect(result.knowledgeBase[0].snippet).toContain('potassium');
    expect(result.openContradictions).toHaveLength(1);
    expect(result.bridgedPairs).toBe(1);
    spy.mockRestore();
  });

  test('a KB-only hit still surfaces contradictions (kb_entry_id + linked wiki id)', async () => {
    const state = useDb({
      knowledge_entries: [],
      knowledge_base: [{ id: 'kb1', content: 'curated potassium article', wiki_entry_id: 'w9' }],
      knowledge_contradictions: [{ contradiction_type: 'efficacy', description: 'label vs outcomes', severity: 0.5, status: 'open' }],
    });
    const spy = jest.spyOn(KnowledgeBridge, 'unifiedSearch').mockResolvedValue({
      claudeopedia: [{ id: 'kb1', slug: 'k-flow', title: 'K-Flow', category: 'chemicals', confidence: 'high' }],
      wiki: [], // no wiki hits — the KB row must still carry its warning
      bridged: [],
    });

    const { executeTool } = require('../services/intelligence-bar/tools');
    const result = await executeTool('search_field_intelligence', { query: 'k-flow' });

    expect(result.openContradictions).toHaveLength(1);
    // the lookup covered BOTH the KB id and the wiki page it links
    const kcCall = state.calls.knowledge_contradictions.at(-1);
    const orIns = kcCall.ops.filter(([m]) => m === 'orWhereIn').map(([, a]) => a);
    expect(orIns).toEqual(expect.arrayContaining([
      ['wiki_entry_id', ['w9']],
      ['kb_entry_id', ['kb1']],
    ]));
    spy.mockRestore();
  });

  test('requires a query', async () => {
    useDb({});
    const { executeTool } = require('../services/intelligence-bar/tools');
    const result = await executeTool('search_field_intelligence', {});
    expect(result.error).toMatch(/query is required/);
  });
});
