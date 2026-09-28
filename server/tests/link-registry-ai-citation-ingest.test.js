/**
 * Backlink Manager v2 — weekly `ai_citation` discovery feeder.
 * Runs the real ensureDomain against a knex-shaped double that records every
 * write, exactly like link-registry-gap-ingest.test.js; no HTTP, no LLM calls
 * (the classifier is pure).
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const { isEnabled } = require('../config/feature-gates');
const {
  runAiCitationFeeder, aggregateCitations, citationDetail, sinceDate, SOURCE, DEFAULT_LOOKBACK_DAYS,
} = require('../services/seo/link-registry-ai-citation-ingest');

function fakeDb({ domains = [], mentions = [], queries = [] } = {}) {
  const store = { domains: [...domains], sources: [], mentions: [...mentions], queries: [...queries], updates: [], selects: [] };
  const builder = (table) => {
    const st = { where: null, cmp: [], whereIn: null, whereNotNull: null, insert: null };
    const q = {
      insert(row) { st.insert = row; return q; },
      onConflict() { return q; },
      ignore() { return q; },
      returning() { return q.then(); },
      select(...cols) { st.select = cols; store.selects.push({ table, cols }); return q; },
      where(a, op, v) { if (typeof a === 'object' && op === undefined) st.where = a; else st.cmp.push([a, op, v]); return q; },
      whereIn(col, vals) { st.whereIn = [col, vals]; return q; },
      whereNotNull(col) { st.whereNotNull = col; return q; },
      orderBy() { return q; },
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
          if (table === 'seo_llm_mentions') {
            let rows = store.mentions;
            for (const [col, op, v] of st.cmp) {
              if (op === '>=') rows = rows.filter((r) => new Date(r[col]) >= new Date(v));
            }
            if (st.whereNotNull) rows = rows.filter((r) => r[st.whereNotNull] != null);
            return rows;
          }
          if (table === 'seo_llm_mention_queries') return store.queries;
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

const NOW = new Date('2026-09-27T12:00:00Z');
// Verbatim benchmark queries (server/data/aeo-benchmark-v1.json) so the
// aggregation's text-based benchmark lookup actually matches in tests.
const Q1_SARASOTA_PEST = 'Who is the best pest control company in Sarasota FL?';
const Q4_SARASOTA_TERMITE = "I'm buying a house in Sarasota — who does the termite / WDO inspection and how much does it cost?";
const mention = (over = {}) => ({
  id: over.id || 'm1', query: Q1_SARASOTA_PEST, query_id: null,
  llm_platform: 'openai', check_date: '2026-09-20', cited_urls: [], ...over,
});

beforeEach(() => isEnabled.mockImplementation(() => true));

describe('aggregateCitations (pure)', () => {
  test('classifies every cited URL, aggregates per host, attaches question context from the benchmark and the managed query row', () => {
    const rows = [
      mention({
        id: 'm1', query: Q1_SARASOTA_PEST, query_id: 'q1', llm_platform: 'openai',
        cited_urls: ['https://www.bbb.org/us/fl/sarasota/profile/pest-control/waves', 'https://www.wavespestcontrol.com/', 'not a url'],
      }),
      mention({
        id: 'm2', query: Q1_SARASOTA_PEST, query_id: 'q1', llm_platform: 'gemini',
        cited_urls: ['https://www.bbb.org/us/fl/sarasota/profile/pest-control/waves'],
      }),
    ];
    const queryRows = [{ id: 'q1', query: Q1_SARASOTA_PEST, city: 'Sarasota', service: 'pest control', active: true }];
    const out = aggregateCitations(rows, queryRows);
    const bbb = out.find((d) => d.host === 'bbb.org');
    expect(bbb).toMatchObject({ category: 'listing', citationCount: 2, locallyRelevant: true });
    expect(bbb.platforms).toEqual(['gemini', 'openai']);
    expect(bbb.questions).toEqual([{ id: 'Q1', query: Q1_SARASOTA_PEST, city: 'Sarasota', service: 'pest control', intent: 'provider' }]);
    const owned = out.find((d) => d.host === 'wavespestcontrol.com');
    expect(owned.category).toBe('owned');
    expect(out.some((d) => d.host === 'not a url')).toBe(false); // unparseable never counted
  });

  test('an unmanaged query still gets city/service/intent from the benchmark alone', () => {
    const rows = [mention({ query: Q4_SARASOTA_TERMITE, query_id: null, cited_urls: ['https://www.yelp.com/biz/waves'] })];
    const out = aggregateCitations(rows, []);
    expect(out[0].questions[0]).toMatchObject({ id: 'Q4', city: 'Sarasota', service: 'termite' });
  });

  test('a row with no cited_urls contributes nothing', () => {
    expect(aggregateCitations([mention({ cited_urls: [] })], [])).toEqual([]);
    expect(aggregateCitations([mention({ cited_urls: null })], [])).toEqual([]);
  });

  // Codex P1 2026-09-28: a host that carries citations under TWO different
  // categories (forbes.com: an eligible /home-improvement/ page beside an
  // ineligible /sites/ article) must aggregate identically whichever URL a
  // run happens to see first — the category can never depend on row order.
  test('a host cited under two different categories aggregates BOTH, order-independent', () => {
    const homeImprovement = 'https://www.forbes.com/home-improvement/pest-control/best-companies/';
    const sitesArticle = 'https://www.forbes.com/sites/someauthor/2026/09/01/pest-control-stocks/';
    const forward = aggregateCitations([mention({ cited_urls: [sitesArticle, homeImprovement] })], []);
    const reverse = aggregateCitations([mention({ cited_urls: [homeImprovement, sitesArticle] })], []);
    for (const out of [forward, reverse]) {
      expect(out).toHaveLength(2);
      const editorial = out.find((d) => d.category === 'editorial');
      const other = out.find((d) => d.category === 'other');
      expect(editorial).toMatchObject({ host: 'forbes.com', category: 'editorial', citationCount: 1 });
      expect(editorial.sampleUrls).toEqual([homeImprovement]);
      expect(other).toMatchObject({ host: 'forbes.com', category: 'other', citationCount: 1 });
      expect(other.sampleUrls).toEqual([sitesArticle]);
    }
    // and the two orderings produce the SAME result, not just the same shape
    expect(forward.map((d) => [d.host, d.category, d.citationCount]).sort())
      .toEqual(reverse.map((d) => [d.host, d.category, d.citationCount]).sort());
  });
});

describe('citationDetail', () => {
  test('is bounded and carries category, count, platforms, and a question label', () => {
    const d = { category: 'listing', citationCount: 3, platforms: ['gemini', 'openai'], locallyRelevant: true, questions: [{ id: 'Q1', query: 'x' }] };
    const label = citationDetail(d);
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label).toMatch(/listing/);
    expect(label).toMatch(/3x/);
    expect(label).toMatch(/Q1/);
    expect(label).toMatch(/local/);
  });
});

describe('sinceDate', () => {
  test('defaults to a positive lookback even for a non-positive input', () => {
    expect(sinceDate(NOW, DEFAULT_LOOKBACK_DAYS).getTime()).toBe(NOW.getTime() - 30 * 86400e3);
    expect(sinceDate(NOW, 0).getTime()).toBe(NOW.getTime() - 1 * 86400e3);
    expect(sinceDate(NOW, -5).getTime()).toBe(NOW.getTime() - 1 * 86400e3);
  });
});

describe('runAiCitationFeeder', () => {
  test('gated off ⇒ zero reads, zero writes', async () => {
    isEnabled.mockImplementation(() => false);
    const db = fakeDb({ mentions: [mention({ cited_urls: ['https://www.bbb.org/x'] })] });
    const r = await runAiCitationFeeder(db, { now: NOW });
    expect(r).toEqual({ gated: true, dryRun: false, scanned: 0, domains: 0, byCategory: {}, enqueued: 0, inserted: 0, touched: 0, existing: 0, candidates: [] });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('only listing + editorial candidates are enqueued; the rest are counted in byCategory', async () => {
    const db = fakeDb({
      mentions: [
        mention({
          id: 'm1', cited_urls: [
            'https://www.bbb.org/us/fl/sarasota/profile/pest-control/waves', // listing
            'https://www.heraldtribune.com/story/pest-control-tips', // editorial
            'https://en.wikipedia.org/wiki/Pest_control', // reference
            'https://www.orkin.com/locations/fl/sarasota', // competitor
            'https://www.reddit.com/r/pestcontrol/comments/1', // community_video
            'https://www.wavespestcontrol.com/', // owned
            'https://www.random-blog-example.test/x', // other
          ],
        }),
      ],
    });
    const r = await runAiCitationFeeder(db, { now: NOW });
    expect(r.gated).toBe(false);
    expect(r.scanned).toBe(1);
    expect(r.domains).toBe(7);
    expect(r.byCategory).toEqual({ listing: 1, editorial: 1, reference: 1, competitor: 1, community_video: 1, owned: 1, other: 1 });
    expect(r.enqueued).toBe(2);
    expect(r.candidates.map((c) => c.domain).sort()).toEqual(['bbb.org', 'heraldtribune.com']);
    expect(db._store.domains.map((d) => d.domain).sort()).toEqual(['bbb.org', 'heraldtribune.com']);
    for (const d of db._store.domains) expect(d.source).toBe(SOURCE);
  });

  test('an existing domain keeps its first-touch source; the ai_citation evidence lands as its own touch row', async () => {
    const db = fakeDb({
      domains: [{ id: 'd1', domain: 'bbb.org', source: 'competitor_gap', discovery_priority: 'normal' }],
      mentions: [mention({ cited_urls: ['https://www.bbb.org/x'] })],
    });
    const r = await runAiCitationFeeder(db, { now: NOW });
    expect(r.inserted).toBe(0);
    expect(r.existing).toBe(1);
    expect(r.touched).toBe(1);
    expect(db._store.domains).toHaveLength(1);
    expect(db._store.domains[0]).toMatchObject({ id: 'd1', source: 'competitor_gap' }); // never rewritten
    expect(db._store.sources).toHaveLength(1);
    expect(db._store.sources[0]).toMatchObject({ domain_id: 'd1', source: 'ai_citation' });
    expect(db._store.sources[0].source_detail).toMatch(/listing/);
  });

  test('dryRun previews inserted vs existing with zero writes', async () => {
    const db = fakeDb({
      domains: [{ id: 'd1', domain: 'bbb.org', source: 'owner_seed' }],
      mentions: [mention({ cited_urls: ['https://www.bbb.org/x', 'https://www.yelp.com/biz/waves'] })],
    });
    const r = await runAiCitationFeeder(db, { dryRun: true, now: NOW });
    expect(r).toMatchObject({ dryRun: true, enqueued: 2, inserted: 1, existing: 1 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db._store.domains).toHaveLength(1); // nothing written
    expect(db._store.sources).toEqual([]);
    const byDomain = Object.fromEntries(r.candidates.map((c) => [c.domain, c.existing]));
    expect(byDomain).toEqual({ 'bbb.org': true, 'yelp.com': false });
  });

  test('no measured rows in the window ⇒ a clean no-op', async () => {
    const db = fakeDb();
    const r = await runAiCitationFeeder(db, { now: NOW });
    expect(r).toEqual({ gated: false, dryRun: false, scanned: 0, domains: 0, byCategory: {}, enqueued: 0, inserted: 0, touched: 0, existing: 0, candidates: [] });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('a lookbackDays window excludes rows outside it', async () => {
    const db = fakeDb({
      mentions: [
        mention({ id: 'old', check_date: '2026-08-01', cited_urls: ['https://www.bbb.org/old'] }),
        mention({ id: 'new', check_date: '2026-09-25', cited_urls: ['https://www.yelp.com/biz/waves'] }),
      ],
    });
    const r = await runAiCitationFeeder(db, { now: NOW, lookbackDays: 30 });
    expect(r.scanned).toBe(1);
    expect(r.candidates.map((c) => c.domain)).toEqual(['yelp.com']);
  });
});
