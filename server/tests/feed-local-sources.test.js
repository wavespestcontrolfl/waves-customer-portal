/**
 * /api/feed/local — multi-source local news merge.
 *
 * The section originally pulled only MySuncoast (WWSB), whose general local
 * feed rarely survives the relevance filter — the portal card sat on "0
 * items". The route now fans out to every major outlet in the Venice →
 * Palmetto corridor and merges the survivors newest-first. Contract:
 *  - all sources fetch in parallel; each item carries its outlet's
 *    sourceName
 *  - the relevance/exclusion keyword filters apply across the merged set
 *  - results interleave by pubDate desc regardless of source order
 *  - a dead source (bad URL, moved feed, 5xx) contributes zero items and
 *    never breaks the endpoint
 *  - links/images stay allowlist-bound (publisher domains + their CDNs)
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));

const express = require('express');

const SUNCOAST_FEED = 'https://www.mysuncoast.com/news/local/rss/';
const HERALD_FEED = 'https://rssfeeds.heraldtribune.com/sarasota/topstories';
const BRADENTON_FEED = 'https://www.bradenton.com/news/local/?widgetName=rssfeed&widgetContentId=712015&getXmlFeed=true';
const GONDOLIER_FEED = 'https://www.venicegondolier.com/search/?f=rss&t=article&l=25&s=start_time&sd=desc';

const HERALD_PAGE = 'https://www.heraldtribune.com/story/news/local/2026/07/06/hurricane-lawn-prep/';
const HERALD_IMG = 'https://www.gannett-cdn.com/presto/2026/07/06/hurricane-prep.jpg';
const BRADENTON_PAGE = 'https://www.bradenton.com/news/local/article301234567.html';
const BRADENTON_IMG = 'https://www.bradenton.com/resizer/v2/mosquito-truck.jpg';
const SUNCOAST_PAGE = 'https://www.mysuncoast.com/2026/07/02/red-tide-update/';

function feed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel><title>t</title>${items}</channel>
</rss>`;
}

// One relevant item (newest, feed-native image) + one keyword-irrelevant
// item that must be filtered out.
const HERALD_XML = feed(`
    <item>
      <title>Hurricane season lawn prep tips for Sarasota homeowners</title>
      <link>${HERALD_PAGE}</link>
      <pubDate>Mon, 06 Jul 2026 12:00:00 GMT</pubDate>
      <description>Get your yard storm-ready.</description>
      <media:content url="${HERALD_IMG}" medium="image" />
    </item>
    <item>
      <title>New downtown restaurant opens its doors</title>
      <link>${HERALD_PAGE}</link>
      <pubDate>Mon, 06 Jul 2026 11:00:00 GMT</pubDate>
      <description>A ribbon cutting downtown.</description>
    </item>`);

// Relevant, image-less — must resolve og:image from the article page.
const BRADENTON_XML = feed(`
    <item>
      <title>Palmetto expands mosquito control spraying this week</title>
      <link>${BRADENTON_PAGE}</link>
      <pubDate>Sun, 05 Jul 2026 12:00:00 GMT</pubDate>
      <description>Manatee County mosquito management adds routes.</description>
    </item>`);

// One relevant item + one that matches RELEVANT but also EXCLUDE (crime).
const SUNCOAST_XML = feed(`
    <item>
      <title>Red Tide Update for Sarasota</title>
      <link>${SUNCOAST_PAGE}</link>
      <pubDate>Thu, 02 Jul 2026 12:00:00 GMT</pubDate>
      <description>Red tide conditions along the coast.</description>
    </item>
    <item>
      <title>Arrest made in lawn equipment theft ring</title>
      <link>${SUNCOAST_PAGE}</link>
      <pubDate>Fri, 03 Jul 2026 12:00:00 GMT</pubDate>
      <description>Deputies recovered stolen mowers.</description>
    </item>`);

const EXTERNAL_ROUTES = {
  [SUNCOAST_FEED]: { text: SUNCOAST_XML },
  [HERALD_FEED]: { text: HERALD_XML },
  [BRADENTON_FEED]: { text: BRADENTON_XML },
  // Dead source: the Gondolier feed 500s — must degrade to zero items.
  [GONDOLIER_FEED]: { status: 500 },
  [BRADENTON_PAGE]: { text: `<html><head><meta property="og:image" content="${BRADENTON_IMG}"></head></html>` },
  [SUNCOAST_PAGE]: { text: '<html><head><title>no og:image</title></head></html>' },
};

const realFetch = global.fetch;
let server;
let base;
let externalCalls;

beforeAll(async () => {
  const a = express();
  a.use('/api/feed', require('../routes/feed'));
  server = a.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  externalCalls = [];
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    externalCalls.push(u);
    const route = EXTERNAL_ROUTES[u];
    if (!route) throw new Error(`unexpected fetch: ${u}`);
    return {
      ok: route.ok !== false && !route.status,
      status: route.status || 200,
      headers: { get: () => null },
      text: async () => route.text || '',
    };
  });
});

afterAll(async () => {
  global.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

test('merges all corridor sources newest-first, tags each item with its outlet, and filters keywords across the merged set', async () => {
  const res = await fetch(`${base}/api/feed/local`);
  expect(res.status).toBe(200);
  const { posts } = await res.json();

  // 4 fixture items pass fetch; the restaurant item fails RELEVANT, the
  // theft item trips EXCLUDE, the Gondolier source is down → 3 survive.
  expect(posts.map((p) => [p.sourceName, p.title])).toEqual([
    ['Herald-Tribune', 'Hurricane season lawn prep tips for Sarasota homeowners'],
    ['Bradenton Herald', 'Palmetto expands mosquito control spraying this week'],
    ['MySuncoast', 'Red Tide Update for Sarasota'],
  ]);

  // Every source was actually attempted, in parallel, including the dead one.
  expect(externalCalls).toEqual(expect.arrayContaining([SUNCOAST_FEED, HERALD_FEED, BRADENTON_FEED, GONDOLIER_FEED]));

  // Images: feed-native wins without a page fetch; image-less items resolve
  // og:image from the (allowlisted) article page; misses degrade to null.
  expect(posts[0].image).toBe(HERALD_IMG);
  expect(externalCalls).not.toContain(HERALD_PAGE);
  expect(posts[1].image).toBe(BRADENTON_IMG);
  expect(posts[2].image).toBeNull();

  // All posts keep the shared /local contract.
  for (const p of posts) expect(p.source).toBe('local');
});
