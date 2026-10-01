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
const { touchKey, TOUCH_DETAIL_MAX } = require('../services/seo/link-registry');

function fakeDb({ domains = [], sources = [], mentions = [], queries = [] } = {}) {
  const store = { domains: [...domains], sources: [...sources], mentions: [...mentions], queries: [...queries], updates: [], selects: [] };
  const builder = (table) => {
    const st = { where: null, cmp: [], whereIns: [], whereNotNull: null, insert: null };
    const q = {
      insert(row) { st.insert = row; return q; },
      onConflict() { return q; },
      ignore() { return q; },
      returning() { return q.then(); },
      select(...cols) { st.select = cols; store.selects.push({ table, cols }); return q; },
      leftJoin() { return q; },
      where(a, op, v) {
        if (typeof a === 'function') { st.activeToggle = true; return q; } // the managed-query toggle (see readMeasuredMentions)
        if (typeof a === 'object' && op === undefined) st.where = a; else st.cmp.push([a, op, v]);
        return q;
      },
      whereIn(col, vals) { st.whereIns.push([col, vals]); return q; },
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
          if (table === 'seo_link_domains' || table === 'seo_link_domain_sources') {
            let rows = table === 'seo_link_domains' ? store.domains : store.sources;
            if (st.where) rows = rows.filter((d) => Object.entries(st.where).every(([k, v]) => d[k] === v));
            for (const [col, vals] of st.whereIns) rows = rows.filter((d) => vals.includes(d[col]));
            return rows;
          }
          if (table === 'seo_llm_mentions') {
            const col = (c) => String(c).replace(/^m\./, '');
            let rows = store.mentions;
            // check_date is an ET calendar DATE, compared as 'YYYY-MM-DD' strings like Postgres DATE >= 'YYYY-MM-DD'
            for (const [c, op, v] of st.cmp) {
              if (op === '>=') rows = rows.filter((r) => String(r[col(c)]) >= String(v));
            }
            if (st.whereNotNull) rows = rows.filter((r) => r[col(st.whereNotNull)] != null);
            if (st.activeToggle) {
              // the LEFT JOIN + (m.query_id IS NULL OR q.active = true)
              rows = rows.filter((r) => r.query_id == null || store.queries.some((qr) => qr.id === r.query_id && qr.active === true));
            }
            return rows;
          }
          if (table === 'seo_llm_mention_queries') return store.queries;
          return [];
        }).then(resolve, reject);
      },
    };
    return q;
  };
  const db = jest.fn((table) => builder(String(table).split(' as ')[0]));
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

  // Owner review 2026-09-28: the provider-intent listicle heuristic wired
  // end-to-end — a domain no static rules-table entry covers, cited on a
  // real PROVIDER question, is promoted to editorial/listicle_candidate; the
  // SAME domain cited on a non-provider question is not.
  describe('provider-intent listicle heuristic, wired through aggregateCitations', () => {
    const LOCAL_LISTICLE_URL = 'https://www.unknownlocaldirectory.example/best-pest-control-sarasota-fl';
    const Q12_IDENTIFY_NON_PROVIDER = 'How can I tell ghost ants from other small ants in Sarasota?'; // benchmark Q12, intent 'identify'

    test('a provider question (Q1_SARASOTA_PEST default) promotes an otherwise-other local listicle URL', () => {
      const out = aggregateCitations([mention({ cited_urls: [LOCAL_LISTICLE_URL] })], []);
      expect(out).toEqual([{
        host: 'unknownlocaldirectory.example', category: 'editorial', rule: expect.stringMatching(/^heuristic:listicle_candidate:/),
        subtype: 'listicle_candidate', citationCount: 1, sampleUrls: [LOCAL_LISTICLE_URL], platforms: ['openai'],
        locallyRelevant: true, questions: [{ id: 'Q1', query: Q1_SARASOTA_PEST, city: 'Sarasota', service: 'pest control', intent: 'provider' }],
      }]);
    });

    // Codex P2 2026-09-28 (round 9): the seeded entity-cohort question is
    // identity evidence — a local-token URL cited under it stays `other`.
    test('negative: the SAME URL cited under the entity question "Who owns Waves Pest Control?" stays other', () => {
      const out = aggregateCitations([mention({ query: 'Who owns Waves Pest Control?', cited_urls: [LOCAL_LISTICLE_URL] })], []);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ host: 'unknownlocaldirectory.example', category: 'other', rule: 'unmatched', subtype: null });
    });

    test('negative: the SAME URL on a non-provider question stays other, no subtype', () => {
      const out = aggregateCitations([mention({ query: Q12_IDENTIFY_NON_PROVIDER, cited_urls: [LOCAL_LISTICLE_URL] })], []);
      expect(out).toEqual([{
        host: 'unknownlocaldirectory.example', category: 'other', rule: 'unmatched', subtype: null,
        citationCount: 1, sampleUrls: [LOCAL_LISTICLE_URL], platforms: ['openai'], locallyRelevant: true,
        questions: [{ id: 'Q12', query: Q12_IDENTIFY_NON_PROVIDER, city: 'Sarasota', service: 'pest control', intent: 'identify' }],
      }]);
    });

    test('citationDetail surfaces the subtype on a heuristic-promoted candidate', () => {
      const out = aggregateCitations([mention({ cited_urls: [LOCAL_LISTICLE_URL] })], []);
      expect(citationDetail(out[0])).toMatch(/listicle_candidate/);
    });
  });
});

describe('citationDetail', () => {
  // Codex P1 2026-09-28: the detail carries the durable `ai_citation:` prefix
  // the authority guard reads, and the exact cited URLs the path investigator
  // extracts — whole URLs only.
  test('starts with the ai_citation: prefix and carries every sampled URL, whole', () => {
    const d = {
      category: 'editorial', subtype: 'listicle_candidate', citationCount: 3, platforms: ['gemini'], questions: [],
      sampleUrls: ['https://cityvetted.com/sarasota/pest-control', 'https://cityvetted.com/bradenton/pest-control', 'https://cityvetted.com/venice/pest-control-companies-long-path'],
    };
    const label = citationDetail(d);
    expect(label.startsWith('ai_citation:editorial:listicle_candidate')).toBe(true);
    expect(label.split(' ').slice(1)).toEqual(d.sampleUrls); // all of them, in order, never truncated
  });

  // Codex P1 2026-09-28 (round 5): a long first URL (long slug + query
  // string) pushed the label past 120 chars and the old character cap then
  // dropped EVERY cited page, including a later short one. The list is now
  // bounded by URL count only; the full label survives, and link-registry's
  // touchKey hashes the over-long dedupe key instead.
  test('a long first URL no longer drops the cited pages — full URLs kept, touch_key hashed', () => {
    const longUrl = `https://cityvetted.com/sarasota/best-pest-control-companies-near-me-2026-reviewed-and-rated?utm_source=${'x'.repeat(80)}&ref=answer-engine`;
    const shortUrl = 'https://cityvetted.com/venice/pest-control';
    const d = { category: 'listing', sampleUrls: [longUrl, shortUrl] };
    const label = citationDetail(d);
    expect(label).toBe(`ai_citation:listing ${longUrl} ${shortUrl}`);
    expect(label.length).toBeGreaterThan(TOUCH_DETAIL_MAX);
    // the investigator's plain URL regex recovers both exact pages
    expect(label.match(/https?:\/\/[^\s"'<>]+/g)).toEqual([longUrl, shortUrl]);
    // the dedupe-key index entry stays bounded via the existing digest fallback
    expect(touchKey(SOURCE, null, label)).toMatch(/^ai_citation:sha256:[0-9a-f]{32}$/);
  });

  test('the list is bounded by URL COUNT: aggregateCitations samples at most 5 distinct URLs per (host, category)', () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://www.bbb.org/us/fl/sarasota/profile/pest-control/company-${i}`);
    const [agg] = aggregateCitations([mention({ cited_urls: urls }), mention({ id: 'm2', cited_urls: [urls[0]] })], []);
    expect(agg.citationCount).toBe(9);
    expect(agg.sampleUrls).toEqual(urls.slice(0, 5)); // most-cited first, then URL order
    expect(citationDetail(agg).split(' ').slice(1)).toEqual(urls.slice(0, 5));
    // and citationDetail itself never emits more than 5, even if handed more
    expect(citationDetail({ category: 'listing', sampleUrls: urls }).split(' ').slice(1)).toEqual(urls.slice(0, 5));
  });

  test('with no sample URLs it is just the prefix and category', () => {
    expect(citationDetail({ category: 'listing', sampleUrls: [] })).toBe('ai_citation:listing');
  });

  // Codex P2 round 6: the DB read has no ordering guarantee, so the sample
  // (and the touch_key derived from it) must not depend on row order.
  test('the same evidence in any row order yields the same sample, detail and touch key', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://www.bbb.org/us/fl/sarasota/profile/pest-control/company-${i}`);
    const rows = [
      mention({ id: 'm1', cited_urls: [urls[6], urls[1]] }),
      mention({ id: 'm2', cited_urls: [urls[5], urls[4], urls[3]] }),
      mention({ id: 'm3', cited_urls: [urls[2], urls[0], urls[6]] }),
    ];
    const [forward] = aggregateCitations(rows, []);
    const [reversed] = aggregateCitations([...rows].reverse(), []);
    expect(forward.sampleUrls).toEqual(reversed.sampleUrls);
    expect(forward.sampleUrls[0]).toBe(urls[6]); // cited twice — sampled first
    expect(touchKey(SOURCE, null, citationDetail(forward))).toBe(touchKey(SOURCE, null, citationDetail(reversed)));
  });
});

describe('sinceDate', () => {
  // Codex P1 2026-09-28 (round 5): check_date is an ET calendar DATE, so the
  // cutoff is an ET 'YYYY-MM-DD' — N ET days INCLUDING today.
  test('returns the oldest ET calendar day of an N-day window, today inclusive', () => {
    expect(sinceDate(NOW, DEFAULT_LOOKBACK_DAYS)).toBe('2026-08-29'); // 2026-09-27 ET and the 29 days before it
    expect(sinceDate(NOW, 7)).toBe('2026-09-21');
  });

  test('defaults to a positive lookback (today only) for a non-positive input', () => {
    expect(sinceDate(NOW, 1)).toBe('2026-09-27');
    expect(sinceDate(NOW, 0)).toBe('2026-09-27');
    expect(sinceDate(NOW, -5)).toBe('2026-09-27');
  });

  test('a run between 00:00 UTC and ET midnight anchors on the ET day, not the UTC day', () => {
    // 2026-09-28T02:30Z is 22:30 EDT on 2026-09-27 — still Sept 27 in ET.
    const lateEvening = new Date('2026-09-28T02:30:00Z');
    expect(sinceDate(lateEvening, 30)).toBe('2026-08-29');
    expect(sinceDate(lateEvening, 1)).toBe('2026-09-27');
    // same ET day at noon ⇒ same cutoff (run time within the ET day never shifts it)
    expect(sinceDate(new Date('2026-09-27T16:00:00Z'), 30)).toBe(sinceDate(lateEvening, 30));
  });

  test('a window spanning the November DST change still returns an ET calendar day', () => {
    // 2026-11-02T03:30Z is 22:30 EST on 2026-11-01 (DST ended that morning).
    expect(sinceDate(new Date('2026-11-02T03:30:00Z'), 7)).toBe('2026-10-26');
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
    expect(r.touched).toBe(1); // bbb.org has no ai_citation touch yet — live would add one
  });

  // Codex P2 2026-09-28 (round 8): the preview's touched count uses the SAME
  // touchKey() ensureDomain uses, against seo_link_domain_sources, so dry-run
  // totals equal a live run's — for an existing domain that already has the
  // exact key (not touched) and one that lacks it (touched).
  describe('dryRun touched count matches a live run', () => {
    const BBB = 'https://www.bbb.org/us/fl/sarasota/profile/pest-control/sample-co';
    const YELP = 'https://www.yelp.com/biz/sample-co-sarasota';
    const ANGI = 'https://www.angi.com/companylist/us/fl/sarasota/sample-co.htm';
    const detailFor = (url) => citationDetail({ category: 'listing', sampleUrls: [url] });
    const fixture = () => ({
      domains: [
        { id: 'd1', domain: 'bbb.org', source: 'competitor_gap', discovery_priority: 'normal' },
        { id: 'd2', domain: 'yelp.com', source: 'competitor_gap', discovery_priority: 'normal' },
      ],
      sources: [
        // bbb.org already carries this exact citation's touch; yelp.com has only an unrelated one
        { id: 's1', domain_id: 'd1', source: 'ai_citation', touch_key: touchKey(SOURCE, null, detailFor(BBB)) },
        { id: 's2', domain_id: 'd2', source: 'competitor_gap', touch_key: 'competitor_gap:scan' },
      ],
      mentions: [mention({ cited_urls: [BBB, YELP, ANGI] })],
    });

    test('existing-with-key ⇒ not touched; existing-without-key ⇒ touched; new ⇒ inserted', async () => {
      const dry = fakeDb(fixture());
      const preview = await runAiCitationFeeder(dry, { dryRun: true, now: NOW });
      expect(preview).toMatchObject({ enqueued: 3, inserted: 1, existing: 2, touched: 1 });
      expect(dry._store.sources).toHaveLength(2); // read-only
      expect(dry._store.domains).toHaveLength(2);

      const live = fakeDb(fixture());
      const actual = await runAiCitationFeeder(live, { now: NOW });
      for (const k of ['enqueued', 'inserted', 'existing', 'touched']) expect(preview[k]).toBe(actual[k]);
    });
  });

  test('no measured rows in the window ⇒ a clean no-op', async () => {
    const db = fakeDb();
    const r = await runAiCitationFeeder(db, { now: NOW });
    expect(r).toEqual({ gated: false, dryRun: false, scanned: 0, domains: 0, byCategory: {}, enqueued: 0, inserted: 0, touched: 0, existing: 0, candidates: [] });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  // Codex P1 2026-09-28 (round 5): at 22:30 EDT on Sept 27 (02:30Z Sept
  // 28) a 30-day window's oldest ET day is Aug 29 — a UTC-instant cutoff
  // would have moved it to Aug 30 and silently dropped that day's rows.
  test('the lookback cutoff is an ET calendar day, pinned at a run between 00:00 UTC and ET midnight', async () => {
    const db = fakeDb({
      mentions: [
        mention({ id: 'before', check_date: '2026-08-28', cited_urls: ['https://www.bbb.org/before'] }),
        mention({ id: 'oldest', check_date: '2026-08-29', cited_urls: ['https://www.yelp.com/biz/oldest'] }),
      ],
    });
    const r = await runAiCitationFeeder(db, { now: new Date('2026-09-28T02:30:00Z'), lookbackDays: 30, dryRun: true });
    expect(r.scanned).toBe(1);
    expect(r.candidates.map((c) => c.domain)).toEqual(['yelp.com']);
  });

  // Codex P2 2026-09-28 (round 5): a deactivated managed query stops feeding
  // the registry; an unmanaged/legacy row (null query_id) has no toggle and
  // is kept — the same rule as gsc-opportunity-miner.js's mineAeoGaps.
  test('drops rows from a deactivated managed query; keeps active-managed and unmanaged rows', async () => {
    const db = fakeDb({
      queries: [
        { id: 'q-on', query: Q1_SARASOTA_PEST, city: 'Sarasota', service: 'pest control', active: true },
        { id: 'q-off', query: Q4_SARASOTA_TERMITE, city: 'Sarasota', service: 'termite', active: false },
      ],
      mentions: [
        mention({ id: 'on', query_id: 'q-on', cited_urls: ['https://www.bbb.org/active'] }),
        mention({ id: 'off', query: Q4_SARASOTA_TERMITE, query_id: 'q-off', cited_urls: ['https://www.angi.com/inactive'] }),
        mention({ id: 'legacy', query_id: null, cited_urls: ['https://www.yelp.com/biz/legacy'] }),
      ],
    });
    const r = await runAiCitationFeeder(db, { now: NOW, dryRun: true });
    expect(r.scanned).toBe(2);
    expect(r.candidates.map((c) => c.domain).sort()).toEqual(['bbb.org', 'yelp.com']);
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
