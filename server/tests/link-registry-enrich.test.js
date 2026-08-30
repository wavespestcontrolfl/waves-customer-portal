/**
 * Backlink Manager v2 step 2 — enrichDomains (plan §4 step 3 "Enrich").
 * DataForSEO is injected; the gate is mocked; the DB is a knex-shaped double
 * that records every update.
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const { isEnabled } = require('../config/feature-gates');
const { enrichDomains, BULK_MAX } = require('../services/seo/link-registry-enrich');

function fakeDb({ domains = [], competitorBacklinks = [] } = {}) {
  const store = { domains: [...domains], competitorBacklinks: [...competitorBacklinks], updates: [] };
  const builder = (table) => {
    const st = { where: null, whereIn: null, whereNull: null, limit: null, orderRaw: null };
    const q = {
      select() { return q; },
      distinct() { return q; },
      where(w) { st.where = w; return q; },
      whereIn(col, vals) { st.whereIn = [col, vals]; return q; },
      whereNull(col) { st.whereNull = col; return q; },
      orderByRaw(s) { st.orderRaw = s; return q; },
      orderBy() { return q; },
      limit(n) { st.limit = n; return q; },
      update(patch) {
        store.updates.push({ table, where: st.where, patch });
        return Promise.resolve(1);
      },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (table === 'seo_link_domains') {
            let rows = store.domains;
            if (st.whereIn) rows = rows.filter((d) => st.whereIn[1].includes(d[st.whereIn[0]]));
            if (st.whereNull) rows = rows.filter((d) => d[st.whereNull] == null);
            if (st.orderRaw) rows = [...rows].sort((a, b) => (a.discovery_priority === 'owner_seed' ? 0 : 1) - (b.discovery_priority === 'owner_seed' ? 0 : 1));
            if (st.limit != null) rows = rows.slice(0, st.limit);
            return rows;
          }
          if (table === 'seo_competitor_backlinks') {
            let rows = store.competitorBacklinks;
            if (st.whereIn) rows = rows.filter((d) => st.whereIn[1].includes(d[st.whereIn[0]]));
            return rows;
          }
          return [];
        }).then(resolve, reject);
      },
    };
    return q;
  };
  const db = jest.fn(builder);
  db.fn = { now: () => 'NOW()' };
  db.transaction = jest.fn(async (fn) => fn(db));
  db._store = store;
  return db;
}

const dfsResp = (rows) => ({ tasks: [{ result: [{ items: rows }] }] });
function fakeDfs({ ranks = [], spam = [], throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async bulkRanks(targets) { calls.push(['bulkRanks', targets]); if (throwOn === 'ranks') throw new Error('DFS down'); return typeof ranks === 'function' ? ranks(targets) : dfsResp(ranks); },
    async bulkSpamScore(targets) { calls.push(['bulkSpamScore', targets]); if (throwOn === 'spam') throw new Error('DFS down'); return typeof spam === 'function' ? spam(targets) : dfsResp(spam); },
  };
}

const NOW = new Date('2026-08-29T12:00:00Z');
const D = (id, domain, extra = {}) => ({ id, domain, discovery_priority: 'normal', enriched_at: null, created_at: NOW, ...extra });

beforeEach(() => { isEnabled.mockReset(); isEnabled.mockReturnValue(true); });

describe('enrichDomains', () => {
  test('enriches a batch with ONE bulkRanks + ONE bulkSpamScore; maps rank/spam/referring_domains; caches raw payloads; enriched_at set', async () => {
    const db = fakeDb({
      domains: [D('d1', 'alpha.example'), D('d2', 'beta.example')],
      competitorBacklinks: [
        { source_domain: 'alpha.example', competitor_domain: 'comp-a.com' },
        { source_domain: 'www.alpha.example', competitor_domain: 'comp-b.com' },
        { source_domain: 'alpha.example', competitor_domain: 'comp-a.com' },
      ],
    });
    const dfs = fakeDfs({
      ranks: [{ target: 'alpha.example', rank: 41, referring_domains: 120 }, { target: 'www.beta.example', rank: 7 }],
      spam: [{ target: 'alpha.example', spam_score: 5 }, { target: 'beta.example', spam_score: 60 }],
    });
    const r = await enrichDomains(db, { dataforseo: dfs, now: NOW });
    expect(r).toMatchObject({ dryRun: false, gated: false, selected: 2, enriched: 2, failed: [], calls: 2 });
    expect(dfs.calls).toEqual([['bulkRanks', ['alpha.example', 'beta.example']], ['bulkSpamScore', ['alpha.example', 'beta.example']]]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(db._store.updates.map((u) => [u.where.id, u.patch]));
    expect(byId.d1).toMatchObject({ domain_rating: 41, referring_domains: 120, spam_score: 5, competitors_linked: 2, enriched_at: NOW });
    expect(byId.d1.organic_traffic).toBeUndefined();
    expect(JSON.parse(byId.d1.enrichment)).toEqual({ fetched_at: NOW.toISOString(), bulk_ranks: { target: 'alpha.example', rank: 41, referring_domains: 120 }, bulk_spam_score: { target: 'alpha.example', spam_score: 5 } });
    // www. spelling in the response still maps onto the canonical host
    expect(byId.d2).toMatchObject({ domain_rating: 7, spam_score: 60, competitors_linked: 0, enriched_at: NOW });
    expect(byId.d2.referring_domains).toBeUndefined();
  });

  test('gated: zero API calls, enriched 0, but competitors_linked is still written (free signal)', async () => {
    isEnabled.mockReturnValue(false);
    const db = fakeDb({
      domains: [D('d1', 'alpha.example')],
      competitorBacklinks: [{ source_domain: 'alpha.example', competitor_domain: 'c1.com' }, { source_domain: 'alpha.example', competitor_domain: 'c2.com' }, { source_domain: 'alpha.example', competitor_domain: 'c3.com' }],
    });
    const dfs = fakeDfs();
    const r = await enrichDomains(db, { dataforseo: dfs, now: NOW });
    expect(r).toMatchObject({ gated: true, selected: 1, enriched: 0, calls: 0, failed: [] });
    expect(isEnabled).toHaveBeenCalledWith('seoIntelligence');
    expect(dfs.calls).toEqual([]);
    expect(db._store.updates).toEqual([{ table: 'seo_link_domains', where: { id: 'd1' }, patch: { competitors_linked: 3, updated_at: NOW } }]);
    // enriched_at stays NULL so the gate flip enriches it later
    expect(db._store.updates[0].patch.enriched_at).toBeUndefined();
  });

  test('chunks at 1000 targets per call: 1500 domains → 2 batches → 4 calls, each ≤1000', async () => {
    const domains = Array.from({ length: 1500 }, (_, i) => D(`d${i}`, `host${i}.example`));
    const db = fakeDb({ domains });
    const dfs = fakeDfs({
      ranks: (targets) => dfsResp(targets.map((t) => ({ target: t, rank: 1 }))),
      spam: (targets) => dfsResp(targets.map((t) => ({ target: t, spam_score: 0 }))),
    });
    const r = await enrichDomains(db, { dataforseo: dfs, limit: 2000, now: NOW });
    expect(r).toMatchObject({ selected: 1500, enriched: 1500, calls: 4, failed: [] });
    expect(dfs.calls.map(([n, t]) => [n, t.length])).toEqual([['bulkRanks', 1000], ['bulkSpamScore', 1000], ['bulkRanks', 500], ['bulkSpamScore', 500]]);
    for (const [, t] of dfs.calls) expect(t.length).toBeLessThanOrEqual(BULK_MAX);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db._store.updates).toHaveLength(1500);
  });

  test('a domain absent from the response still gets enriched_at + { missing: true } (never re-spent on)', async () => {
    const db = fakeDb({ domains: [D('d1', 'present.example'), D('d2', 'absent.example')] });
    const dfs = fakeDfs({ ranks: [{ target: 'present.example', rank: 10 }], spam: [{ target: 'present.example', spam_score: 1 }] });
    const r = await enrichDomains(db, { dataforseo: dfs, now: NOW });
    expect(r).toMatchObject({ enriched: 2, failed: [], calls: 2 });
    const absent = db._store.updates.find((u) => u.where.id === 'd2').patch;
    expect(absent.enriched_at).toEqual(NOW);
    expect(JSON.parse(absent.enrichment)).toEqual({ missing: true, fetched_at: NOW.toISOString() });
    expect(absent.domain_rating).toBeUndefined();
    expect(absent.spam_score).toBeUndefined();
    // half-present: the missing half is flagged inside the cache, the present half is mapped
    const db2 = fakeDb({ domains: [D('d1', 'half.example')] });
    await enrichDomains(db2, { dataforseo: fakeDfs({ ranks: [{ target: 'half.example', rank: 3 }], spam: [] }), now: NOW });
    const half = db2._store.updates[0].patch;
    expect(half).toMatchObject({ domain_rating: 3, enriched_at: NOW });
    expect(JSON.parse(half.enrichment)).toMatchObject({ bulk_ranks: { rank: 3 }, bulk_spam_score: { missing: true } });
  });

  test('dryRun: selection + counts only — zero writes, zero API calls', async () => {
    const db = fakeDb({ domains: [D('d1', 'a.example'), D('d2', 'b.example'), D('d3', 'c.example', { enriched_at: NOW })] });
    const dfs = fakeDfs({ ranks: [{ target: 'a.example', rank: 1 }] });
    const r = await enrichDomains(db, { dataforseo: dfs, dryRun: true, now: NOW });
    expect(r).toMatchObject({ dryRun: true, gated: false, selected: 2, enriched: 0, calls: 0, failed: [], wouldCall: 2 });
    expect(dfs.calls).toEqual([]);
    expect(db._store.updates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('selection: un-enriched only unless force; explicit domainIds; owner_seed first; limit honored', async () => {
    const domains = [D('d1', 'n1.example'), D('d2', 'seed.example', { discovery_priority: 'owner_seed' }), D('d3', 'done.example', { enriched_at: NOW })];
    const dfs = () => fakeDfs({ ranks: (t) => dfsResp(t.map((x) => ({ target: x, rank: 1 }))), spam: (t) => dfsResp(t.map((x) => ({ target: x, spam_score: 0 }))) });
    let d = dfs();
    expect((await enrichDomains(fakeDb({ domains }), { dataforseo: d, now: NOW })).selected).toBe(2);
    expect(d.calls[0][1]).toEqual(['seed.example', 'n1.example']); // owner_seed first
    d = dfs();
    expect((await enrichDomains(fakeDb({ domains }), { dataforseo: d, force: true, now: NOW })).selected).toBe(3);
    d = dfs();
    expect((await enrichDomains(fakeDb({ domains }), { dataforseo: d, domainIds: ['d3'], now: NOW })).selected).toBe(1);
    expect(d.calls[0][1]).toEqual(['done.example']);
    d = dfs();
    expect((await enrichDomains(fakeDb({ domains }), { dataforseo: d, domainIds: [], now: NOW })).selected).toBe(0);
    expect(d.calls).toEqual([]);
    d = dfs();
    expect((await enrichDomains(fakeDb({ domains }), { dataforseo: d, limit: 1, now: NOW })).selected).toBe(1);
    expect(d.calls[0][1]).toEqual(['seed.example']);
  });

  test('a thrown DataForSEO error aborts the batch with zero writes (propagates)', async () => {
    const db = fakeDb({ domains: [D('d1', 'a.example')] });
    await expect(enrichDomains(db, { dataforseo: fakeDfs({ throwOn: 'spam' }), now: NOW })).rejects.toThrow('DFS down');
    expect(db._store.updates).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a null response (client swallowed a transport/auth failure) = batch failed, enriched_at left NULL for retry, competitors_linked still written', async () => {
    const db = fakeDb({ domains: [D('d1', 'a.example')], competitorBacklinks: [{ source_domain: 'a.example', competitor_domain: 'c.com' }] });
    const dfs = { async bulkRanks() { return null; }, async bulkSpamScore() { return dfsResp([]); } };
    const r = await enrichDomains(db, { dataforseo: dfs, now: NOW });
    expect(r).toMatchObject({ enriched: 0, calls: 2, failed: [{ id: 'd1', domain: 'a.example', reason: 'bulk_ranks_no_response' }] });
    expect(db._store.updates).toEqual([{ table: 'seo_link_domains', where: { id: 'd1' }, patch: { competitors_linked: 1, updated_at: NOW } }]);
  });
});
