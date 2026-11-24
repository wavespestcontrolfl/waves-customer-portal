/**
 * google-index-ping.js: hub sitemap resubmit + Indexing API pings for /careers/ job pages ONLY.
 * Google allows urlNotifications.publish only for JobPosting / BroadcastEvent pages, so the
 * tests pin that no other URL is ever sent, plus idempotence (state moves only on success).
 */
let mockState;
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    where() { return this; },
    first: jest.fn(async () => (mockState === undefined ? undefined : { value: mockState })),
    insert(row) {
      return { onConflict() { return { merge: jest.fn(async () => { mockState = row.value; }) }; } };
    },
  }));
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/search-console-v2', () => ({
  resolveAccessibleProperty: jest.fn(),
  submitSitemap: jest.fn(),
  _internals: { gscAuthOptions: jest.fn() },
}));

const SearchConsole = require('../services/seo/search-console-v2');
const logger = require('../services/logger');
const { runGoogleIndexPing, htmlHasJobPosting, assertJobUrl, isNoindex, MAX_PUBLISHES_PER_RUN } = require('../services/seo/google-index-ping');

const ORIGIN = 'https://www.wavespestcontrol.com';
const JOB_LD = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"Tech"}]}</script>';
const ORG_LD = '<script type="application/ld+json">{"@type":"Organization","name":"Waves"}</script>';

function sitemapXml(entries) {
  return `<urlset>${entries.map(([loc, mod]) => `<url><loc>${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`).join('')}</urlset>`;
}

// pages: { url: html | { status, html, headers } }; unknown URLs answer 404.
function response(status, text = '', headers = {}) {
  return { status, ok: status >= 200 && status < 300, text: async () => text, headers: { get: (k) => headers[k.toLowerCase()] || null } };
}
function makeFetch({ entries, pages = {}, failUrl = null, sitemaps = null }) {
  const docs = sitemaps || { [`${ORIGIN}/sitemap-0.xml`]: sitemapXml(entries) };
  return jest.fn(async (url) => {
    if (url === failUrl) return response(500);
    if (url === `${ORIGIN}/sitemap-index.xml`) return response(200, `<sitemapindex>${Object.keys(docs).map((d) => `<sitemap><loc>${d}</loc></sitemap>`).join('')}</sitemapindex>`);
    if (url in docs) return response(200, docs[url]);
    if (url in pages) {
      const p = pages[url];
      return typeof p === 'string' ? response(200, p) : response(p.status || 200, p.html || '', p.headers || {});
    }
    return response(404);
  });
}

const published = (indexing) => indexing.urlNotifications.publish.mock.calls.map(([a]) => [a.requestBody.type, a.requestBody.url]);
let indexing;

beforeEach(() => {
  jest.clearAllMocks();
  mockState = undefined;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
  SearchConsole.resolveAccessibleProperty.mockResolvedValue({ siteUrl: `${ORIGIN}/` });
  SearchConsole.submitSitemap.mockResolvedValue({ ok: true });
  indexing = { urlNotifications: { publish: jest.fn().mockResolvedValue({}) } };
});

const JOB = `${ORIGIN}/careers/pest-control-technician/`;
const run = (opts) => runGoogleIndexPing({ indexing, ...opts });

test('unchanged sitemap submits nothing and publishes nothing', async () => {
  const fetchFn = makeFetch({ entries: [[`${ORIGIN}/`, '2026-11-01'], [JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } });
  await run({ fetchFn });
  SearchConsole.submitSitemap.mockClear();
  indexing.urlNotifications.publish.mockClear();
  const second = await run({ fetchFn });
  expect(SearchConsole.submitSitemap).not.toHaveBeenCalled();
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
  expect(second).toMatchObject({ sitemapSubmitted: false, updated: 0, deleted: 0 });
});

test('changed sitemap submits the index once and saves the fingerprint', async () => {
  const first = await run({ fetchFn: makeFetch({ entries: [[`${ORIGIN}/`, '2026-11-01']] }) });
  expect(first.sitemapSubmitted).toBe(true);
  expect(SearchConsole.submitSitemap).toHaveBeenCalledTimes(1);
  expect(SearchConsole.submitSitemap).toHaveBeenCalledWith(`${ORIGIN}/`, `${ORIGIN}/sitemap-index.xml`);
  const saved = JSON.parse(mockState);
  expect(saved.sitemapFingerprint).toMatch(/^[0-9a-f]{64}$/);
  await run({ fetchFn: makeFetch({ entries: [[`${ORIGIN}/`, '2026-11-02']] }) });
  expect(SearchConsole.submitSitemap).toHaveBeenCalledTimes(2);
});

test('a job page with JobPosting JSON-LD gets URL_UPDATED, again only when its lastmod moves', async () => {
  const pages = { [JOB]: JOB_LD };
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages }) });
  expect(published(indexing)).toEqual([['URL_UPDATED', JOB]]);
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages }) });
  expect(indexing.urlNotifications.publish).toHaveBeenCalledTimes(1);
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-09']], pages }) });
  expect(published(indexing)).toEqual([['URL_UPDATED', JOB], ['URL_UPDATED', JOB]]);
});

test('non-job pages are never published: /careers/ without JobPosting, and pages outside /careers/', async () => {
  const apply = `${ORIGIN}/careers/apply/`;
  const blog = `${ORIGIN}/blog/ant-control/`;
  const fetchFn = makeFetch({
    entries: [[apply, '2026-11-01'], [blog, '2026-11-01'], [`${ORIGIN}/`, null]],
    // The blog page even carries a JobPosting: it is outside /careers/, so it must not be sent.
    pages: { [apply]: ORG_LD, [blog]: JOB_LD, [`${ORIGIN}/`]: JOB_LD },
  });
  await run({ fetchFn });
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalledWith(blog, expect.anything());
  // The checked non-job is remembered: not fetched again at the same lastmod.
  fetchFn.mockClear();
  await run({ fetchFn });
  expect(fetchFn).not.toHaveBeenCalledWith(apply, expect.anything());
});

test('a job URL that left the sitemap gets URL_DELETED once', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01'], [`${ORIGIN}/`, null]], pages: { [JOB]: JOB_LD } }) });
  indexing.urlNotifications.publish.mockClear();
  const fetchFn = makeFetch({ entries: [[`${ORIGIN}/`, null]] });
  await run({ fetchFn });
  expect(published(indexing)).toEqual([['URL_DELETED', JOB]]);
  await run({ fetchFn });
  expect(indexing.urlNotifications.publish).toHaveBeenCalledTimes(1);
});

test('URL_DELETED needs evidence: 404, 410 or noindex send it; a live page or a redirect drops the URL quietly', async () => {
  const cases = [
    ['404', { status: 404 }, true],
    ['410', { status: 410 }, true],
    ['noindex meta', { html: '<meta name="robots" content="noindex, follow">' }, true],
    ['X-Robots-Tag', { html: ORG_LD, headers: { 'x-robots-tag': 'noindex' } }, true],
    ['live page without JobPosting', { html: ORG_LD }, false],
    ['301 elsewhere', { status: 301 }, false],
  ];
  for (const [name, page, sent] of cases) {
    mockState = undefined;
    indexing.urlNotifications.publish.mockClear();
    await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } }) });
    indexing.urlNotifications.publish.mockClear();
    // Lost its JobPosting while still in the sitemap.
    await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-05']], pages: { [JOB]: page } }) });
    expect([name, published(indexing)]).toEqual([name, sent ? [['URL_DELETED', JOB]] : []]);
    expect(JSON.parse(mockState).jobs).toEqual({});
  }
});

test('a job URL that left the sitemap but is still live is dropped without a notification', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01'], [`${ORIGIN}/`, null]], pages: { [JOB]: JOB_LD } }) });
  indexing.urlNotifications.publish.mockClear();
  await run({ fetchFn: makeFetch({ entries: [[`${ORIGIN}/`, null]], pages: { [JOB]: JOB_LD } }) });
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
  expect(JSON.parse(mockState).jobs).toEqual({});
});

test('a job URL that errors (5xx) when checked keeps its state and retries', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01'], [`${ORIGIN}/`, null]], pages: { [JOB]: JOB_LD } }) });
  indexing.urlNotifications.publish.mockClear();
  await run({ fetchFn: makeFetch({ entries: [[`${ORIGIN}/`, null]], pages: { [JOB]: { status: 503 } } }) });
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
  expect(Object.keys(JSON.parse(mockState).jobs)).toEqual([JOB]);
});

test('sitemap fetches stay on the https hub host and never follow redirects', async () => {
  const fetchFn = makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } });
  await run({ fetchFn });
  for (const [url, init] of fetchFn.mock.calls) {
    expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(init.redirect).toBe('manual');
  }
});

test('an off-host child sitemap, a redirect or a non-hub scheme aborts the run before any Google call', async () => {
  for (const loc of ['https://evil.example/sitemap.xml', 'http://www.wavespestcontrol.com/sitemap-0.xml', 'https://wavespestcontrol.com/sitemap-0.xml']) {
    const fetchFn = makeFetch({ sitemaps: { [loc]: sitemapXml([[JOB, '2026-11-01']]) } });
    const out = await run({ fetchFn });
    expect(out.errors).toBe(1);
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual([`${ORIGIN}/sitemap-index.xml`]);
  }
  const redirected = jest.fn(async () => response(301, '', { location: 'https://evil.example/' }));
  await expect(run({ fetchFn: redirected })).resolves.toMatchObject({ errors: 1 });
  expect(SearchConsole.submitSitemap).not.toHaveBeenCalled();
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
});

test('an incomplete sitemap read aborts the run and keeps prior state', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } }) });
  const before = mockState;
  SearchConsole.submitSitemap.mockClear();
  indexing.urlNotifications.publish.mockClear();
  const good = `${ORIGIN}/sitemap-0.xml`;
  const bad = `${ORIGIN}/sitemap-1.xml`;
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`${ORIGIN}/sitemap-${i}.xml`, sitemapXml([[`${ORIGIN}/p${i}/`, null]])]));
  const broken = [
    { [good]: sitemapXml([[`${ORIGIN}/`, null]]), [bad]: '<html><body>200 but not a sitemap</body></html>' },
    { [good]: sitemapXml([[`${ORIGIN}/`, null]]), [bad]: '<urlset></urlset>' },
    many,
  ];
  for (const sitemaps of broken) {
    await expect(run({ fetchFn: makeFetch({ sitemaps }) })).resolves.toMatchObject({ errors: 1, updated: 0, deleted: 0 });
  }
  expect(mockState).toBe(before);
  expect(SearchConsole.submitSitemap).not.toHaveBeenCalled();
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
});

test('an sc-domain property still reads and guards the www hub origin', async () => {
  SearchConsole.resolveAccessibleProperty.mockResolvedValue({ siteUrl: 'sc-domain:wavespestcontrol.com' });
  const out = await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } }) });
  expect(out).toMatchObject({ sitemapSubmitted: true, updated: 1, errors: 0 });
  expect(SearchConsole.submitSitemap).toHaveBeenCalledWith('sc-domain:wavespestcontrol.com', `${ORIGIN}/sitemap-index.xml`);
  expect(published(indexing)).toEqual([['URL_UPDATED', JOB]]);
});

test('an undated careers page is rechecked at most once per 24 h and pinged only when its JobPosting changes', async () => {
  const T0 = Date.parse('2026-11-23T12:00:00Z');
  const H = 60 * 60 * 1000;
  const entries = [[JOB, null]];
  const fetchFn = makeFetch({ entries, pages: { [JOB]: JOB_LD } });
  await run({ fetchFn, now: T0 });
  expect(indexing.urlNotifications.publish).toHaveBeenCalledTimes(1);
  // Within 24 h: not even fetched.
  fetchFn.mockClear();
  await run({ fetchFn, now: T0 + 23 * H });
  expect(fetchFn).not.toHaveBeenCalledWith(JOB, expect.anything());
  // After 24 h, same content: fetched, no duplicate notification, check time moves.
  await run({ fetchFn, now: T0 + 25 * H });
  expect(fetchFn).toHaveBeenCalledWith(JOB, expect.anything());
  expect(indexing.urlNotifications.publish).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockState).jobs[JOB].checkedAt).toBe(new Date(T0 + 25 * H).toISOString());
  // After another 24 h with changed content: URL_UPDATED.
  const changed = JOB_LD.replace('"Tech"', '"Senior Tech"');
  await run({ fetchFn: makeFetch({ entries, pages: { [JOB]: changed } }), now: T0 + 50 * H });
  expect(indexing.urlNotifications.publish).toHaveBeenCalledTimes(2);
});

test('a Google error warns, leaves state alone, never throws, and the next run retries', async () => {
  const fetchFn = makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } });
  SearchConsole.submitSitemap.mockResolvedValueOnce({ error: 'nope' });
  indexing.urlNotifications.publish.mockRejectedValueOnce(Object.assign(new Error('quota'), { code: 429 }));
  const first = await run({ fetchFn });
  expect(first).toMatchObject({ sitemapSubmitted: false, updated: 0, errors: 2 });
  expect(logger.warn).toHaveBeenCalled();
  expect(mockState === undefined || JSON.parse(mockState).sitemapFingerprint === null).toBe(true);
  expect(mockState === undefined || Object.keys(JSON.parse(mockState).jobs).length === 0).toBe(true);
  const second = await run({ fetchFn });
  expect(second).toMatchObject({ sitemapSubmitted: true, updated: 1, errors: 0 });
});

test('an unreadable sitemap stops the run before any Google call', async () => {
  const fetchFn = makeFetch({ entries: [[JOB, '2026-11-01']], failUrl: `${ORIGIN}/sitemap-0.xml` });
  await expect(run({ fetchFn })).resolves.toMatchObject({ errors: 1 });
  expect(SearchConsole.submitSitemap).not.toHaveBeenCalled();
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
});

test('at most MAX_PUBLISHES_PER_RUN notifications per run; the rest catch up next run', async () => {
  const jobs = Array.from({ length: MAX_PUBLISHES_PER_RUN + 5 }, (_, i) => `${ORIGIN}/careers/role-${i}/`);
  const fetchFn = makeFetch({ entries: jobs.map((j) => [j, '2026-11-01']), pages: Object.fromEntries(jobs.map((j) => [j, JOB_LD])) });
  const first = await run({ fetchFn });
  expect(first.updated).toBe(MAX_PUBLISHES_PER_RUN);
  const second = await run({ fetchFn });
  expect(second.updated).toBe(5);
  expect(new Set(published(indexing).map(([, u]) => u)).size).toBe(MAX_PUBLISHES_PER_RUN + 5);
});

test('unconfigured service account skips quietly', async () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  await expect(run({ fetchFn: jest.fn() })).resolves.toEqual({ skipped: 'not_configured' });
});

test('an inconclusive answer (429, 408, 5xx, 403 or a network error) keeps a known job untouched and never caches a page as a non-job', async () => {
  const first = await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01'], [`${ORIGIN}/`, null]], pages: { [JOB]: JOB_LD } }) });
  expect(first.updated).toBe(1);
  const before = mockState;
  indexing.urlNotifications.publish.mockClear();
  for (const status of [429, 408, 500, 503, 403]) {
    // Still in the sitemap with a moved lastmod: the page check is inconclusive.
    await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-09'], [`${ORIGIN}/`, null]], pages: { [JOB]: { status } } }) });
    // Left the sitemap: the deletion check is inconclusive.
    await run({ fetchFn: makeFetch({ entries: [[`${ORIGIN}/`, null]], pages: { [JOB]: { status } } }) });
  }
  const network = (entries) => {
    const inner = makeFetch({ entries, pages: { [JOB]: JOB_LD } });
    return jest.fn(async (url, init) => { if (url === JOB) throw new Error('socket hang up'); return inner(url, init); });
  };
  await run({ fetchFn: network([[JOB, '2026-11-09'], [`${ORIGIN}/`, null]]) });
  await run({ fetchFn: network([[`${ORIGIN}/`, null]]) });
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
  const after = JSON.parse(mockState);
  expect(after.jobs[JOB]).toEqual(JSON.parse(before).jobs[JOB]);
  expect(after.nonJobs[JOB]).toBeUndefined();
  // An unknown page that answers 429 is not remembered as a non-job either.
  mockState = undefined;
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: { status: 429 } } }) });
  expect(mockState === undefined || JSON.parse(mockState).nonJobs[JOB] === undefined).toBe(true);
});

test('noindex counts only when it binds Google: no prefix or googlebot, never another crawler or a value directive', () => {
  const header = (value) => ({ get: (k) => (k === 'x-robots-tag' ? value : null) });
  const meta = (name, content) => `<meta name="${name}" content="${content}">`;
  const yes = [
    [header('noindex')], [header('none')], [header('googlebot: noindex')], [header('GoogleBot: NONE')],
    [header('nofollow, noindex')], [header('bingbot: nofollow, googlebot: noindex')],
    [header('max-snippet: 5, noindex')],
    [null, meta('robots', 'noindex, follow')], [null, meta('googlebot', 'none')], [null, "<meta content='noindex' name='robots'>"],
  ];
  const no = [
    [header('bingbot: noindex')], [header('bingbot: noindex, nofollow')], [header('googlebot: nofollow, bingbot: noindex')],
    [header('max-image-preview: none')], [header('max-snippet: 0, nofollow')], [header('nofollow')], [header(null)],
    [null, meta('bingbot', 'noindex')], [null, meta('robots', 'max-image-preview:none')], [null, meta('robots', 'index, follow')],
    [null, meta('description', 'noindex')], [null, '<p>noindex</p>'],
  ];
  for (const [h, html] of yes) expect([h?.get('x-robots-tag'), html, isNoindex(h, html || '')]).toEqual([h?.get('x-robots-tag'), html, true]);
  for (const [h, html] of no) expect([h?.get('x-robots-tag'), html, isNoindex(h, html || '')]).toEqual([h?.get('x-robots-tag'), html, false]);
});

test('a truncated 200 sitemap body (index or child) aborts the run before state changes', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } }) });
  const before = mockState;
  SearchConsole.submitSitemap.mockClear();
  indexing.urlNotifications.publish.mockClear();
  const full = sitemapXml([[`${ORIGIN}/`, null], [JOB, '2026-11-01']]);
  const truncatedChild = full.slice(0, full.indexOf('</url>', full.indexOf('careers')) - 3);
  const out = await run({ fetchFn: makeFetch({ sitemaps: { [`${ORIGIN}/sitemap-0.xml`]: truncatedChild } }) });
  expect(out.errors).toBe(1);
  const truncatedIndex = jest.fn(async () => response(200, `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-0.xml</loc>`));
  expect((await run({ fetchFn: truncatedIndex })).errors).toBe(1);
  expect(mockState).toBe(before);
  expect(SearchConsole.submitSitemap).not.toHaveBeenCalled();
  expect(indexing.urlNotifications.publish).not.toHaveBeenCalled();
});

test('guards: assertJobUrl refuses anything outside hub /careers/; JSON-LD detection', () => {
  expect(() => assertJobUrl(JOB)).not.toThrow();
  expect(() => assertJobUrl(`${ORIGIN}/blog/x/`)).toThrow(/non-job/);
  expect(() => assertJobUrl('https://example.com/careers/x/')).toThrow(/non-job/);
  expect(() => assertJobUrl('nope')).toThrow();
  expect(() => assertJobUrl('http://www.wavespestcontrol.com/careers/x/')).toThrow(/non-job/);
  expect(() => assertJobUrl('https://wavespestcontrol.com/careers/x/')).toThrow(/non-job/);
  expect(htmlHasJobPosting(JOB_LD)).toBe(true);
  expect(htmlHasJobPosting('<script type="application/ld+json">{"@type":["Thing","JobPosting"]}</script>')).toBe(true);
  expect(htmlHasJobPosting(ORG_LD)).toBe(false);
  expect(htmlHasJobPosting('<script type="application/ld+json">{bad</script><p>JobPosting</p>')).toBe(false);
});
