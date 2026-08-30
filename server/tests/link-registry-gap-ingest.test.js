/**
 * Backlink Manager v2 step 2 — competitor-gap feeder (plan §4 "Feeders").
 * Runs the real ensureDomain against a knex-shaped double that records
 * every write; no HTTP, no DataForSEO.
 */
const { ingestCompetitorGap, classifyGapDomains, isOwnHost } = require('../services/seo/link-registry-gap-ingest');
const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');

function fakeDb({ domains = [], competitorBacklinks = [] } = {}) {
  const store = { domains: [...domains], sources: [], competitorBacklinks: [...competitorBacklinks], updates: [], queries: [] };
  const builder = (table) => {
    const st = { where: null, whereIn: null, insert: null, cmp: null };
    const q = {
      insert(row) { st.insert = row; return q; },
      onConflict() { return q; },
      ignore() { return q; },
      returning() { return q.then(); },
      select() { return q; },
      distinct() { return q; },
      where(a, op, v) { if (typeof a === 'object') st.where = a; else st.cmp = [a, op, v]; return q; },
      whereIn(col, vals) { st.whereIn = [col, vals]; store.queries.push({ table, whereIn: [col, vals] }); return q; },
      async first() { const r = await q.then(); return r[0]; },
      update(patch) { store.updates.push({ table, where: st.where, patch }); return Promise.resolve(1); },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (st.insert) {
            if (table === 'seo_link_domains') {
              if (store.domains.some((d) => d.domain === st.insert.domain)) return [];
              const row = { id: `d${store.domains.length + 1}`, discovery_priority: 'normal', ...st.insert };
              store.domains.push(row); return [{ id: row.id }];
            }
            if (table === 'seo_link_domain_sources') {
              if (store.sources.some((s) => s.domain_id === st.insert.domain_id && s.touch_key === st.insert.touch_key)) return [];
              const row = { id: `s${store.sources.length + 1}`, ...st.insert };
              store.sources.push(row); return [{ id: row.id }];
            }
            throw new Error(`unexpected insert into ${table}`);
          }
          if (table === 'seo_link_domains') {
            let rows = store.domains;
            if (st.where) rows = rows.filter((d) => Object.entries(st.where).every(([k, v]) => d[k] === v));
            if (st.whereIn) rows = rows.filter((d) => st.whereIn[1].includes(d[st.whereIn[0]]));
            return rows;
          }
          if (table === 'seo_competitor_backlinks') {
            let rows = store.competitorBacklinks;
            if (st.cmp) { const [col, , v] = st.cmp; rows = rows.filter((r) => r[col] != null && new Date(r[col]) >= new Date(v)); }
            const seen = new Set();
            return rows.filter((r) => (seen.has(r.source_domain) ? false : (seen.add(r.source_domain), true))).map((r) => ({ source_domain: r.source_domain }));
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

const NOW = new Date('2026-08-29T12:00:00Z');
const CB = (source_domain, competitor_domain = 'comp.com', first_seen = '2026-08-01') => ({ source_domain, competitor_domain, first_seen });

describe('classifyGapDomains (pure)', () => {
  test('canonicalizes, dedupes www./case/url spellings, skips own + never-target hosts with reasons, invalid flagged', () => {
    const r = classifyGapDomains(['Example.com', 'www.example.com', 'https://EXAMPLE.com/page', 'bradentonchamber.org', 'wavespestcontrol.com', 'blog.wavespestcontrol.com', SPOKE_SITE_KEYS[1], 'x.com', 'bit.ly', 't.co', '', null]);
    expect(r.candidates).toEqual(['example.com', 'bradentonchamber.org']);
    expect(r.skipped).toEqual([
      { domain: 'wavespestcontrol.com', reason: 'own_domain' },
      { domain: 'blog.wavespestcontrol.com', reason: 'own_domain' },
      { domain: SPOKE_SITE_KEYS[1], reason: 'own_domain' },
      { domain: 'x.com', reason: 'never_target' },
      { domain: 'bit.ly', reason: 'never_target' },
      { domain: 't.co', reason: 'never_target' },
      { domain: '', reason: 'invalid' },
      { domain: '', reason: 'invalid' },
    ]);
    expect(isOwnHost('www.wavespestcontrol.com')).toBe(true);
    expect(isOwnHost('notwavespestcontrol.com')).toBe(false);
  });
});

describe('ingestCompetitorGap', () => {
  test('unknown hosts insert with first-touch competitor_gap; known hosts are touched, not inserted; first-touch source untouched', async () => {
    const db = fakeDb({
      domains: [{ id: 'd1', domain: 'known.example', source: 'owner_seed', discovery_priority: 'owner_seed' }],
      competitorBacklinks: [CB('known.example', 'c1.com'), CB('www.known.example', 'c2.com'), CB('fresh.example'), CB('Fresh.example', 'c2.com'), CB('wavespestcontrol.com'), CB('x.com')],
    });
    const r = await ingestCompetitorGap(db, { now: NOW });
    expect(r).toEqual({
      dryRun: false, scanned: 6, candidates: 2, inserted: 1, touched: 1, existing: 1,
      skipped: [{ domain: 'wavespestcontrol.com', reason: 'own_domain' }, { domain: 'x.com', reason: 'never_target' }],
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db._store.domains).toHaveLength(2);
    expect(db._store.domains[0]).toMatchObject({ id: 'd1', source: 'owner_seed' }); // never rewritten
    expect(db._store.domains[1]).toMatchObject({ domain: 'fresh.example', source: 'competitor_gap', source_detail: 'competitor_gap_scan', source_ref: null, discovery_priority: 'normal', agent_state: 'new' });
    expect(db._store.sources.map((s) => [s.domain_id, s.touch_key, s.seen_at])).toEqual([
      ['d1', 'competitor_gap:competitor_gap_scan', NOW],
      ['d2', 'competitor_gap:competitor_gap_scan', NOW],
    ]);
    expect(db._store.updates).toEqual([]); // competitor_gap never raises priority
  });

  test('idempotent: a second run inserts nothing and touches nothing', async () => {
    const db = fakeDb({ competitorBacklinks: [CB('a.example'), CB('b.example')] });
    expect(await ingestCompetitorGap(db, { now: NOW })).toMatchObject({ inserted: 2, touched: 0, existing: 0 });
    expect(await ingestCompetitorGap(db, { now: NOW })).toMatchObject({ inserted: 0, touched: 0, existing: 2 });
    expect(db._store.domains).toHaveLength(2);
    expect(db._store.sources).toHaveLength(2);
  });

  test('dryRun: one whereIn splits would-insert vs existing; zero writes', async () => {
    const db = fakeDb({
      domains: [{ id: 'd1', domain: 'known.example', source: 'list_import' }],
      competitorBacklinks: [CB('known.example'), CB('new1.example'), CB('new2.example'), CB('twitter.com')],
    });
    const r = await ingestCompetitorGap(db, { dryRun: true, now: NOW });
    expect(r).toEqual({ dryRun: true, scanned: 4, candidates: 3, inserted: 2, touched: 0, existing: 1, skipped: [{ domain: 'twitter.com', reason: 'never_target' }] });
    expect(db._store.queries).toEqual([{ table: 'seo_link_domains', whereIn: ['domain', ['known.example', 'new1.example', 'new2.example']] }]);
    expect(db._store.domains).toHaveLength(1);
    expect(db._store.sources).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('since narrows to first_seen >= since; limit caps candidates after dedupe; empty scan is a no-op', async () => {
    const db = fakeDb({ competitorBacklinks: [CB('old.example', 'c', '2026-07-01'), CB('new.example', 'c', '2026-08-20'), CB('newer.example', 'c', '2026-08-25')] });
    const r = await ingestCompetitorGap(db, { since: '2026-08-15', now: NOW });
    expect(r).toMatchObject({ scanned: 2, candidates: 2, inserted: 2 });
    expect(db._store.domains.map((d) => d.domain)).toEqual(['new.example', 'newer.example']);
    const db2 = fakeDb({ competitorBacklinks: [CB('a.example'), CB('www.a.example'), CB('b.example'), CB('c.example')] });
    expect(await ingestCompetitorGap(db2, { limit: 2, now: NOW })).toMatchObject({ scanned: 4, candidates: 2, inserted: 2 });
    expect(db2._store.domains.map((d) => d.domain)).toEqual(['a.example', 'b.example']);
    const db3 = fakeDb();
    expect(await ingestCompetitorGap(db3, { now: NOW })).toEqual({ dryRun: false, scanned: 0, candidates: 0, inserted: 0, touched: 0, existing: 0, skipped: [] });
    expect(db3.transaction).not.toHaveBeenCalled();
  });
});
