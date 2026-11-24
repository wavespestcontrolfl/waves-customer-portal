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
const { runGoogleIndexPing, htmlHasJobPosting, assertJobUrl, MAX_PUBLISHES_PER_RUN } = require('../services/seo/google-index-ping');

const ORIGIN = 'https://www.wavespestcontrol.com';
const JOB_LD = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"JobPosting","title":"Tech"}]}</script>';
const ORG_LD = '<script type="application/ld+json">{"@type":"Organization","name":"Waves"}</script>';

function sitemapXml(entries) {
  return `<urlset>${entries.map(([loc, mod]) => `<url><loc>${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`).join('')}</urlset>`;
}

// pages: { url: html }; entries: [[loc, lastmod]]
function makeFetch({ entries, pages = {}, failUrl = null }) {
  return jest.fn(async (url) => {
    if (url === failUrl) return { ok: false, status: 500, text: async () => '' };
    if (url === `${ORIGIN}/sitemap-index.xml`) return { ok: true, text: async () => `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-0.xml</loc></sitemap></sitemapindex>` };
    if (url === `${ORIGIN}/sitemap-0.xml`) return { ok: true, text: async () => sitemapXml(entries) };
    if (url in pages) return { ok: true, text: async () => pages[url] };
    return { ok: false, status: 404, text: async () => '' };
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

test('a job page that lost its JobPosting is sent URL_DELETED', async () => {
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-01']], pages: { [JOB]: JOB_LD } }) });
  indexing.urlNotifications.publish.mockClear();
  await run({ fetchFn: makeFetch({ entries: [[JOB, '2026-11-05']], pages: { [JOB]: ORG_LD } }) });
  expect(published(indexing)).toEqual([['URL_DELETED', JOB]]);
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

test('guards: assertJobUrl refuses anything outside hub /careers/; JSON-LD detection', () => {
  expect(() => assertJobUrl(JOB, ORIGIN)).not.toThrow();
  expect(() => assertJobUrl(`${ORIGIN}/blog/x/`, ORIGIN)).toThrow(/non-job/);
  expect(() => assertJobUrl('https://example.com/careers/x/', ORIGIN)).toThrow(/non-job/);
  expect(() => assertJobUrl('nope', ORIGIN)).toThrow();
  expect(htmlHasJobPosting(JOB_LD)).toBe(true);
  expect(htmlHasJobPosting('<script type="application/ld+json">{"@type":["Thing","JobPosting"]}</script>')).toBe(true);
  expect(htmlHasJobPosting(ORG_LD)).toBe(false);
  expect(htmlHasJobPosting('<script type="application/ld+json">{bad</script><p>JobPosting</p>')).toBe(false);
});
