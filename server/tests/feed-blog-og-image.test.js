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
 */
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/newsletter-feed', () => ({ getPublishedPosts: jest.fn(async () => []) }));

const express = require('express');

const FEED_URL = 'https://www.wavespestcontrol.com/feed.xml';
const PAGE_WITH_HERO = 'https://www.wavespestcontrol.com/blog/lizard-faeces-southwest-florida/';
const PAGE_NO_HERO = 'https://www.wavespestcontrol.com/blog/what-are-maggots/';
const PAGE_BAD_HOST_HERO = 'https://www.wavespestcontrol.com/blog/dog-fleas-human-hair/';
const PAGE_WITH_MEDIA = 'https://www.wavespestcontrol.com/blog/chinch-bugs/';
const HERO = 'https://www.wavespestcontrol.com/images/blog/lizard-faeces-southwest-florida/hero.webp';
const MEDIA_IMG = 'https://www.wavespestcontrol.com/images/blog/chinch-bugs/hero.webp';

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
  </channel>
</rss>`;

const EXTERNAL_ROUTES = {
  [FEED_URL]: { text: FEED_XML },
  [PAGE_WITH_HERO]: { text: `<html><head><meta property="og:image" content="${HERO}"></head></html>` },
  [PAGE_NO_HERO]: { text: '<html><head><title>no hero</title></head></html>' },
  [PAGE_BAD_HOST_HERO]: { text: '<html><head><meta property="og:image" content="https://evil.example.com/x.png"></head></html>' },
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
    return { ok: true, text: async () => route.text };
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
  expect(posts).toHaveLength(4);

  // No feed image → resolved from the page's og:image.
  expect(posts[0].image).toBe(HERO);
  // Page without an og:image tag → null, not an error.
  expect(posts[1].image).toBeNull();
  // og:image pointing off the trusted-host allowlist → rejected to null.
  expect(posts[2].image).toBeNull();
  // Feed-native media:content wins — its page must never be fetched.
  expect(posts[3].image).toBe(MEDIA_IMG);
  expect(externalCalls).not.toContain(PAGE_WITH_MEDIA);

  // Everything else about the item contract is unchanged.
  expect(posts[0]).toMatchObject({
    title: 'Lizard Faeces in Southwest Florida',
    link: PAGE_WITH_HERO,
    source: 'blog',
    sourceName: 'Waves Blog',
  });
});
