/**
 * /api/feed/blog — hero image fallback via og:image.
 *
 * The Astro hub's feed.xml carries no media:content/media:thumbnail/enclosure
 * and no inline <img> in descriptions, so extractImage() misses on every item
 * and the customer portal rendered icon placeholders instead of post heroes.
 * The route now resolves missing images from the live page's og:image (the
 * blog layout stamps the hero there — same source social-media.js uses for
 * blog shares). Contract:
 *  - items with feed-native images keep them and never trigger a page fetch
 *  - items without one get the page's og:image, host-validated by safeImage
 *  - og:image on an untrusted host, a missing tag, or a fetch failure all
 *    degrade to image:null (client falls back to the icon placeholder)
 *  - the /experts (UF/IFAS) and /local (MySuncoast) feeds get the same
 *    fallback for their image-less items
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));
// No DB in this suite: /local degrades to serving the current fetch
// directly (the pre-bank path this file's expectations were written for).
jest.mock('../services/local-news-store', () => ({
  newLinks: jest.fn(async () => { throw new Error('no db in this suite'); }),
  insertItems: jest.fn(),
  latestItems: jest.fn(),
}));

const express = require('express');

const FEED_URL = 'https://www.wavespestcontrol.com/feed.xml';
const PAGE_WITH_HERO = 'https://www.wavespestcontrol.com/blog/lizard-faeces-southwest-florida/';
const PAGE_NO_HERO = 'https://www.wavespestcontrol.com/blog/what-are-maggots/';
const PAGE_BAD_HOST_HERO = 'https://www.wavespestcontrol.com/blog/dog-fleas-human-hair/';
const PAGE_WITH_MEDIA = 'https://www.wavespestcontrol.com/blog/chinch-bugs/';
const PAGE_REDIRECT_EVIL = 'https://www.wavespestcontrol.com/blog/moved-offsite/';
const EVIL_REDIRECT_TARGET = 'https://evil.example.com/landing';
const PAGE_REDIRECT_OK = 'https://www.wavespestcontrol.com/blog/old-slug/';
const PAGE_REDIRECT_TARGET = 'https://www.wavespestcontrol.com/blog/new-slug/';
const HERO = 'https://www.wavespestcontrol.com/images/blog/lizard-faeces-southwest-florida/hero.webp';
const MEDIA_IMG = 'https://www.wavespestcontrol.com/images/blog/chinch-bugs/hero.webp';
const REDIRECTED_HERO = 'https://www.wavespestcontrol.com/images/blog/new-slug/hero.webp';

// Mirrors the Astro hub feed shape: title/link/pubDate/description only —
// no media:*, no enclosure, no inline <img> — except the last item, which
// carries media:content to prove feed-native images short-circuit the fetch.
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Waves Blog</title>
    <item>
      <title>Lizard Faeces in Southwest Florida</title>
      <link>${PAGE_WITH_HERO}</link>
      <pubDate>Sat, 05 Jul 2026 09:00:00 GMT</pubDate>
      <description>Found dark pellets with a chalky white tip?</description>
    </item>
    <item>
      <title>What Are Maggots?</title>
      <link>${PAGE_NO_HERO}</link>
      <pubDate>Sat, 05 Jul 2026 08:00:00 GMT</pubDate>
      <description>Maggots are fly larvae.</description>
    </item>
    <item>
      <title>Can Dog Fleas Live in Human Hair?</title>
      <link>${PAGE_BAD_HOST_HERO}</link>
      <pubDate>Fri, 03 Jul 2026 08:00:00 GMT</pubDate>
      <description>Here's what's actually happening.</description>
    </item>
    <item>
      <title>Chinch Bugs</title>
      <link>${PAGE_WITH_MEDIA}</link>
      <pubDate>Thu, 02 Jul 2026 08:00:00 GMT</pubDate>
      <description>Sunny-edge yellowing.</description>
      <media:content url="${MEDIA_IMG}" medium="image" />
    </item>
    <item>
      <title>Moved Offsite</title>
      <link>${PAGE_REDIRECT_EVIL}</link>
      <pubDate>Wed, 01 Jul 2026 08:00:00 GMT</pubDate>
      <description>Trusted link that redirects off-allowlist.</description>
    </item>
    <item>
      <title>Renamed Post</title>
      <link>${PAGE_REDIRECT_OK}</link>
      <pubDate>Tue, 30 Jun 2026 08:00:00 GMT</pubDate>
      <description>Trusted link that redirects to another trusted page.</description>
    </item>
  </channel>
</rss>`;

// /experts and /local fixtures — one relevant image-less item per feed
// (titles must pass the RELEVANT_KEYWORDS filter), plus one IFAS item with a
// feed-native content:encoded <img> that must not trigger a page fetch.
const IFAS_SARASOTA_FEED = 'https://blogs.ifas.ufl.edu/sarasotaco/feed/';
const IFAS_MANATEE_FEED = 'https://blogs.ifas.ufl.edu/manateeco/feed/';
const SUNCOAST_FEED = 'https://www.mysuncoast.com/news/local/rss/';
const IFAS_PAGE = 'https://blogs.ifas.ufl.edu/sarasotaco/2026/07/01/lawn-fungus-watch/';
const IFAS_HERO = 'https://blogs.ifas.ufl.edu/sarasotaco/files/2026/07/fungus.jpg';
const IFAS_NATIVE_PAGE = 'https://blogs.ifas.ufl.edu/manateeco/2026/06/28/chinch-bug-scouting/';
const IFAS_NATIVE_IMG = 'https://blogs.ifas.ufl.edu/manateeco/files/2026/06/chinch.jpg';
const SUNCOAST_PAGE = 'https://www.mysuncoast.com/2026/07/02/red-tide-update/';

function wpFeed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>WP</title>${items}</channel>
</rss>`;
}

const IFAS_SARASOTA_XML = wpFeed(`
    <item>
      <title>Lawn Fungus Watch</title>
      <link>${IFAS_PAGE}</link>
      <pubDate>Wed, 01 Jul 2026 12:00:00 GMT</pubDate>
      <description>Large patch season is coming to your lawn.</description>
    </item>`);

const IFAS_MANATEE_XML = wpFeed(`
    <item>
      <title>Chinch Bug Scouting</title>
      <link>${IFAS_NATIVE_PAGE}</link>
      <pubDate>Sun, 28 Jun 2026 12:00:00 GMT</pubDate>
      <description>Scout your turf edges.</description>
      <content:encoded><![CDATA[<p>Scout.</p><img src="${IFAS_NATIVE_IMG}" alt="chinch">]]></content:encoded>
    </item>`);

const SUNCOAST_XML = wpFeed(`
    <item>
      <title>Red Tide Update for Sarasota</title>
      <link>${SUNCOAST_PAGE}</link>
      <pubDate>Thu, 02 Jul 2026 12:00:00 GMT</pubDate>
      <description>Red tide conditions along the coast.</description>
    </item>`);

// The other /local sources answer with empty channels here — this file
// covers the og:image fallback; the multi-source merge has its own test
// (feed-local-sources.test.js).
const HERALD_FEED = 'https://rssfeeds.heraldtribune.com/sarasota/topstories';
const BRADENTON_FEED = 'https://www.bradenton.com/news/local/?widgetName=rssfeed&widgetContentId=712015&getXmlFeed=true';
const GONDOLIER_FEED = 'https://www.venicegondolier.com/search/?f=rss&t=article&l=25&s=start_time&sd=desc';
const TAMPABAY_FEED = 'https://www.tampabay.com/arc/outboundfeeds/rss/?outputType=xml';
const EMPTY_XML = wpFeed('');

const EXTERNAL_ROUTES = {
  [FEED_URL]: { text: FEED_XML },
  [PAGE_WITH_HERO]: { text: `<html><head><meta property="og:image" content="${HERO}"></head></html>` },
  [PAGE_NO_HERO]: { text: '<html><head><title>no hero</title></head></html>' },
  [PAGE_BAD_HOST_HERO]: { text: '<html><head><meta property="og:image" content="https://evil.example.com/x.png"></head></html>' },
  // Redirect hops are validated by safeLink before being followed: the
  // off-allowlist target must never be fetched; the trusted target is.
  [PAGE_REDIRECT_EVIL]: { status: 302, location: EVIL_REDIRECT_TARGET },
  [PAGE_REDIRECT_OK]: { status: 301, location: PAGE_REDIRECT_TARGET },
  [PAGE_REDIRECT_TARGET]: { text: `<html><head><meta property="og:image" content="${REDIRECTED_HERO}"></head></html>` },
  [IFAS_SARASOTA_FEED]: { text: IFAS_SARASOTA_XML },
  [IFAS_MANATEE_FEED]: { text: IFAS_MANATEE_XML },
  [SUNCOAST_FEED]: { text: SUNCOAST_XML },
  [HERALD_FEED]: { text: EMPTY_XML },
  [BRADENTON_FEED]: { text: EMPTY_XML },
  [GONDOLIER_FEED]: { text: EMPTY_XML },
  [TAMPABAY_FEED]: { text: EMPTY_XML },
  [IFAS_PAGE]: { text: `<html><head><meta property="og:image" content="${IFAS_HERO}"></head></html>` },
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
      headers: { get: (n) => (String(n).toLowerCase() === 'location' ? route.location || null : null) },
      text: async () => route.text || '',
    };
  });
});

afterAll(async () => {
  global.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

test('blog posts missing feed images get the live page og:image; misses and untrusted hosts degrade to null', async () => {
  const res = await fetch(`${base}/api/feed/blog`);
  expect(res.status).toBe(200);
  const { posts } = await res.json();
  expect(posts).toHaveLength(6);

  // No feed image → resolved from the page's og:image.
  expect(posts[0].image).toBe(HERO);
  // Page without an og:image tag → null, not an error.
  expect(posts[1].image).toBeNull();
  // og:image pointing off the trusted-host allowlist → rejected to null.
  expect(posts[2].image).toBeNull();
  // Feed-native media:content wins — its page must never be fetched.
  expect(posts[3].image).toBe(MEDIA_IMG);
  expect(externalCalls).not.toContain(PAGE_WITH_MEDIA);
  // Redirect to an off-allowlist host → degrade to null WITHOUT fetching it.
  expect(posts[4].image).toBeNull();
  expect(externalCalls).not.toContain(EVIL_REDIRECT_TARGET);
  // Redirect to another trusted page → followed, og:image resolved.
  expect(posts[5].image).toBe(REDIRECTED_HERO);
  expect(externalCalls).toContain(PAGE_REDIRECT_TARGET);

  // Everything else about the item contract is unchanged.
  expect(posts[0]).toMatchObject({
    title: 'Lizard Faeces in Southwest Florida',
    link: PAGE_WITH_HERO,
    source: 'blog',
    sourceName: 'Waves Blog',
  });
});

test('/experts gets the same og:image fallback; feed-native content:encoded images still win without a page fetch', async () => {
  const res = await fetch(`${base}/api/feed/experts`);
  expect(res.status).toBe(200);
  const { posts } = await res.json();
  expect(posts).toHaveLength(2);

  const fungus = posts.find((p) => p.link === IFAS_PAGE);
  const chinch = posts.find((p) => p.link === IFAS_NATIVE_PAGE);
  expect(fungus.image).toBe(IFAS_HERO);
  expect(chinch.image).toBe(IFAS_NATIVE_IMG);
  expect(externalCalls).not.toContain(IFAS_NATIVE_PAGE);
});

test('/local gets the fallback too; a page without og:image degrades to null', async () => {
  const res = await fetch(`${base}/api/feed/local`);
  expect(res.status).toBe(200);
  const { posts } = await res.json();
  expect(posts).toHaveLength(1);
  expect(posts[0].link).toBe(SUNCOAST_PAGE);
  expect(posts[0].image).toBeNull();
});
