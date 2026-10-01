/**
 * Cited pages — page-level ranking of the third-party pages answer engines
 * cite (server/services/seo/cited-pages.js). Pure ranking over fixture rows;
 * no DB, no HTTP.
 */
const { rankCitedPages, pageKey, displayUrl, currentRowIds } = require('../services/seo/cited-pages');

const Q1 = 'Who is the best pest control company in Sarasota FL?'; // provider, Sarasota
const Q7 = 'What pest control companies serve Parrish FL?'; // provider, Parrish
const Q5 = 'Best no-contract pest control near Lakewood Ranch FL?'; // provider, Lakewood Ranch
const Q3 = 'How much does quarterly pest control cost in the Bradenton / Sarasota area?'; // cost

let seq = 0;
function row({ query, platform = 'perplexity', date = '2026-09-30', urls = [], named = false, model = 'sonar', answered = true }) {
  seq += 1;
  return {
    id: `m${seq}`, query, query_id: null, llm_platform: platform, model_version: model, check_date: date, cited_urls: answered ? urls : null, waves_mentioned: named,
    measurement_version: 2, answer_available: answered, citations_complete: answered,
  };
}

describe('pageKey', () => {
  test('one article is one page across tracking parameters, www, case and trailing slash', () => {
    const a = pageKey('https://www.Floridist.com/Best-Pest-Control-Sarasota/?utm_source=chatgpt.com');
    const b = pageKey('https://floridist.com/best-pest-control-sarasota#top');
    expect(a).toBe('floridist.com/best-pest-control-sarasota');
    expect(b).toBe(a);
  });

  test('a real query parameter stays part of the page, sorted', () => {
    expect(pageKey('https://expertise.com/list?city=sarasota&b=1&utm_medium=x')).toBe('expertise.com/list?b=1&city=sarasota');
  });

  test('unparseable or non-web URLs have no key', () => {
    expect(pageKey('not a url')).toBeNull();
    expect(pageKey('mailto:a@b.com')).toBeNull();
  });

  test('displayUrl strips tracking parameters and the fragment', () => {
    expect(displayUrl('https://floridist.com/a/?utm_source=chatgpt.com&x=1#f')).toBe('https://floridist.com/a/?x=1');
  });
});

describe('currentRowIds', () => {
  test('newest row per question, engine and model counts as current', () => {
    const newer = row({ query: Q1, date: '2026-09-30' });
    const older = row({ query: Q1, date: '2026-09-20' });
    expect([...currentRowIds([newer, older], null)]).toEqual([newer.id]);
  });

  test('a two-surface engine counts only its current surface, newest per question', () => {
    const app = row({ query: Q1, platform: 'chatgpt', model: 'dataforseo:chatgpt_app:gpt-5', date: '2026-09-29' });
    const api = row({ query: Q1, platform: 'chatgpt', model: 'gpt-5-search-api', date: '2026-09-30' });
    const ids = currentRowIds([api, app], { chatgpt: 'app', gemini: 'app' });
    expect(ids.has(app.id)).toBe(true);
    expect(ids.has(api.id)).toBe(false);
  });
});

describe('rankCitedPages', () => {
  test('pages in current provider answers without Waves come first, with the questions and engines', () => {
    const rows = [
      row({ query: Q1, platform: 'perplexity', urls: ['https://floridist.com/best-pest-control-sarasota/?utm_source=x', 'https://www.yelp.com/search?find_desc=pest&find_loc=Sarasota'], named: false }),
      row({ query: Q1, platform: 'claude', model: 'claude', urls: ['https://floridist.com/best-pest-control-sarasota'], named: false }),
      row({ query: Q7, platform: 'perplexity', urls: ['https://www.bbb.org/us/fl/parrish/category/pest-control'], named: true }),
      row({ query: Q3, platform: 'perplexity', urls: ['https://www.bobvila.com/articles/pest-control-cost/'], named: false }),
    ];
    const pages = rankCitedPages(rows, []);
    expect(pages.map((p) => [p.key, p.tier])).toEqual([
      ['floridist.com/best-pest-control-sarasota', 1],
      ['yelp.com/search?find_desc=pest&find_loc=Sarasota', 1],
      ['bbb.org/us/fl/parrish/category/pest-control', 2],
      ['bobvila.com/articles/pest-control-cost', 3],
    ]);
    const top = pages[0];
    expect(top.rank).toBe(1);
    expect(top.url).toBe('https://floridist.com/best-pest-control-sarasota');
    expect(top.currentMisses).toBe(2);
    expect(top.missEngines).toEqual(['claude', 'perplexity']);
    expect(top.priorityCity).toBe(true);
    expect(top.questions).toEqual([expect.objectContaining({ id: 'Q1', city: 'Sarasota', provider: true, current: true, miss: true, engines: ['claude', 'perplexity'] })]);
  });

  test('only listing and editorial pages are ranked — owned, competitor and community pages never are', () => {
    const rows = [row({
      query: Q1,
      urls: ['https://www.wavespestcontrol.com/pest-control-sarasota-fl/', 'https://www.turnerpest.com/sarasota/', 'https://www.reddit.com/r/Sarasota/comments/x/', 'https://floridist.com/best'],
    })];
    expect(rankCitedPages(rows, []).map((p) => p.host)).toEqual(['floridist.com']);
  });

  test('an older answer is history, not a current miss', () => {
    const rows = [
      row({ query: Q1, date: '2026-09-30', urls: ['https://www.yelp.com/biz/a'], named: true }),
      row({ query: Q1, date: '2026-09-10', urls: ['https://floridist.com/best-pest-control-sarasota'], named: false }),
    ];
    const [yelp, floridist] = rankCitedPages(rows, []);
    expect(yelp).toMatchObject({ host: 'yelp.com', tier: 2, currentMisses: 0, namedIn: 1 });
    expect(floridist).toMatchObject({ host: 'floridist.com', tier: 3, currentMisses: 0, citations: 1, currentCitations: 0 });
    expect(floridist.questions[0]).toMatchObject({ current: false, miss: false });
  });

  test('within a tier, more misses first, then a priority city', () => {
    const rows = [
      // Lakewood Ranch (not a priority city), two engines missing
      row({ query: Q5, platform: 'perplexity', urls: ['https://floridist.com/lwr'] }),
      row({ query: Q5, platform: 'claude', model: 'claude', urls: ['https://floridist.com/lwr'] }),
      // Parrish (priority city), one engine missing each
      row({ query: Q7, platform: 'perplexity', urls: ['https://smarfle.com/parrish'] }),
      // Lakewood Ranch, one engine missing
      row({ query: Q5, platform: 'gemini', model: 'gemini', urls: ['https://www.yelp.com/lwr'] }),
    ];
    expect(rankCitedPages(rows, []).map((p) => p.host)).toEqual(['floridist.com', 'smarfle.com', 'yelp.com']);
  });

  test('a failed newest probe stays the current observation — the older answer is history, not a current miss', () => {
    const rows = [
      row({ query: Q1, date: '2026-09-30', answered: false }),
      row({ query: Q1, date: '2026-09-20', urls: ['https://floridist.com/best'], named: false }),
    ];
    expect(rankCitedPages(rows, [])[0]).toMatchObject({ tier: 3, currentMisses: 0, currentCitations: 0, citations: 1 });
  });

  test('one answer citing the same page twice counts once', () => {
    const rows = [row({ query: Q1, urls: ['https://floridist.com/best?utm_source=a', 'https://floridist.com/best/'] })];
    expect(rankCitedPages(rows, [])[0]).toMatchObject({ citations: 1, currentMisses: 1 });
  });

  test('the managed query row supplies the city ahead of the benchmark', () => {
    const r = row({ query: 'best exterminator near me', urls: ['https://floridist.com/x'] });
    r.query_id = 'q1';
    const [page] = rankCitedPages([r], [{ id: 'q1', query: r.query, city: 'Venice', service: 'pest control', active: true }]);
    expect(page.priorityCity).toBe(true);
    expect(page.questions[0]).toMatchObject({ city: 'Venice', provider: true, miss: true });
  });

  test('limit caps the list after ranking', () => {
    const rows = [row({ query: Q1, urls: ['https://floridist.com/a', 'https://floridist.com/b', 'https://floridist.com/c'] })];
    expect(rankCitedPages(rows, [], { limit: 2 }).map((p) => p.rank)).toEqual([1, 2]);
  });
});

describe('recheckPlacements', () => {
  const { recheckPlacements } = require('../services/seo/cited-pages');
  const NOW = new Date('2026-10-20T16:00:00Z');
  const placement = (o = {}) => ({ id: 'p1', target_domain: 'floridist.com', live_url: 'https://floridist.com/best-pest-control-sarasota', first_live_at: '2026-10-01T15:00:00Z', ...o });
  const PAGE = 'https://floridist.com/best-pest-control-sarasota?utm_source=chatgpt.com';

  test('before vs after on the questions that cited the page before it went live', () => {
    const rows = [
      row({ query: Q1, date: '2026-09-20', urls: [PAGE], named: false }),
      row({ query: Q1, date: '2026-09-25', urls: [PAGE], named: false }),
      row({ query: Q7, date: '2026-09-25', urls: ['https://www.bbb.org/x'], named: false }), // never cited the page
      row({ query: Q1, date: '2026-10-10', urls: [PAGE], named: true }),
      row({ query: Q1, platform: 'claude', model: 'claude', date: '2026-10-15', urls: ['https://www.yelp.com/x'], named: false }),
    ];
    const [r] = recheckPlacements([placement()], rows, { now: NOW });
    expect(r).toMatchObject({
      prospectId: 'p1', host: 'floridist.com', liveOn: '2026-10-01', daysLive: 19,
      page: 'floridist.com/best-pest-control-sarasota', questions: [Q1],
      before: { answers: 2, named: 0, citingPage: 2, namedWhenCiting: 0 },
      after: { answers: 2, named: 1, citingPage: 1, namedWhenCiting: 1 },
      current: { answers: 2, citingPage: 1, namedWhenCiting: 1 },
      verdict: 'named_when_cited',
    });
  });

  test('verdicts: too early, page no longer cited, not named yet', () => {
    const before = row({ query: Q1, date: '2026-09-25', urls: [PAGE] });
    expect(recheckPlacements([placement()], [before, row({ query: Q1, date: '2026-10-05', urls: [PAGE] })], { now: new Date('2026-10-08T16:00:00Z') })[0].verdict).toBe('too_early');
    expect(recheckPlacements([placement()], [before], { now: NOW })[0].verdict).toBe('too_early'); // no answer since
    // a named answer inside the settling window is still too early
    expect(recheckPlacements([placement()], [before, row({ query: Q1, date: '2026-10-05', urls: [PAGE], named: true })], { now: new Date('2026-10-08T16:00:00Z') })[0].verdict).toBe('too_early');
    expect(recheckPlacements([placement()], [before, row({ query: Q1, date: '2026-10-18', urls: ['https://www.yelp.com/x'] })], { now: NOW })[0].verdict).toBe('page_not_cited_now');
    expect(recheckPlacements([placement()], [before, row({ query: Q1, date: '2026-10-18', urls: [PAGE] })], { now: NOW })[0].verdict).toBe('not_named_yet');
  });

  test('only the placement\'s own page counts — another page on the same site, a missing live_url or another host is not rechecked', () => {
    const rows = [row({ query: Q1, date: '2026-09-25', urls: [PAGE, 'https://floridist.com/lwr'] })];
    expect(recheckPlacements([placement({ live_url: 'https://floridist.com/LWR/' })], rows, { now: NOW })[0].page).toBe('floridist.com/lwr');
    expect(recheckPlacements([placement({ live_url: 'https://floridist.com/partners' })], rows, { now: NOW })).toEqual([]);
    expect(recheckPlacements([placement({ live_url: null })], rows, { now: NOW })).toEqual([]);
    expect(recheckPlacements([placement({ target_domain: 'other.com' })], rows, { now: NOW })).toEqual([]);
  });

  test('the verdict follows the newest answers — an early named answer does not stick', () => {
    const rows = [
      row({ query: Q1, date: '2026-09-25', urls: [PAGE] }),
      row({ query: Q1, date: '2026-10-05', urls: [PAGE], named: true }),
      row({ query: Q1, date: '2026-10-18', urls: ['https://www.yelp.com/x'], named: false }),
    ];
    const [r] = recheckPlacements([placement()], rows, { now: NOW });
    expect(r.after).toMatchObject({ answers: 2, namedWhenCiting: 1 });
    expect(r.current).toEqual({ answers: 1, citingPage: 0, namedWhenCiting: 0 });
    expect(r.verdict).toBe('page_not_cited_now');
  });

  test('a failed newest probe stays newest — the older named answer is not current', () => {
    const rows = [
      row({ query: Q1, date: '2026-09-25', urls: [PAGE] }),
      row({ query: Q1, date: '2026-10-05', urls: [PAGE], named: true }),
      row({ query: Q1, date: '2026-10-18', answered: false }),
    ];
    const [r] = recheckPlacements([placement()], rows, { now: NOW });
    expect(r.after).toMatchObject({ answers: 1, namedWhenCiting: 1 });
    expect(r.current).toEqual({ answers: 0, citingPage: 0, namedWhenCiting: 0 });
    expect(r.verdict).toBe('too_early');
  });

  test('a date-only first_live_at (UTC midnight) keeps its calendar day', () => {
    const rows = [row({ query: Q1, date: '2026-09-25', urls: [PAGE] })];
    expect(recheckPlacements([placement({ first_live_at: new Date('2026-10-01T00:00:00.000Z') })], rows, { now: NOW })[0].liveOn).toBe('2026-10-01');
    expect(recheckPlacements([placement({ first_live_at: '2026-10-01T03:00:00Z' })], rows, { now: NOW })[0].liveOn).toBe('2026-09-30');
  });

  test('a citation older than the placement\'s own 30-day window never defines its questions', () => {
    const rows = [row({ query: Q1, date: '2026-08-15', urls: [PAGE] }), row({ query: Q1, date: '2026-10-10', urls: [PAGE] })];
    expect(recheckPlacements([placement()], rows, { now: NOW })).toEqual([]);
  });

  test('citations after the link went live never define the questions', () => {
    const rows = [row({ query: Q1, date: '2026-10-05', urls: [PAGE], named: true })];
    expect(recheckPlacements([placement()], rows, { now: NOW })).toEqual([]);
  });
});
