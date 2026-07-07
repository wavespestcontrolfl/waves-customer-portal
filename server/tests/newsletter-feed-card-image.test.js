/**
 * newsletter-feed getPublishedPosts — card thumbnail extraction.
 *
 * Feed cards (portal Learn tab + public landing grid) rendered icon
 * placeholders for every newsletter because the service hardcoded
 * image:null, even though every sent body embeds images. The card image is
 * now the first NON-GIF <img> in html_body:
 *  - the generated hero (jpg, first in the body when present) wins
 *  - the Waves divider GIF and Giphy reaction GIFs never surface (.gif
 *    skip covers both, including Beehiiv-proxied giphy uploads)
 *  - hero-less issues fall back to the first event photo
 *  - all-GIF or image-less bodies degrade to image:null (icon placeholder)
 *  - only clean http(s) URLs pass — the client puts this in CSS
 *    background:url(...), so js:/data:/breakout characters are rejected
 */
jest.mock('../services/newsletter-draft', () => ({
  stripPersonalizationTokens: (s) => s,
}));

let mockRows = [];
jest.mock('../models/db', () => {
  const builder = {
    where() { return builder; },
    whereNotNull() { return builder; },
    orderBy() { return builder; },
    limit() { return Promise.resolve(mockRows); },
    first() { return Promise.resolve(mockRows[0] || null); },
  };
  return jest.fn(() => builder);
});

const { getPublishedPosts } = require('../services/newsletter-feed');

const HERO = 'https://cdn.wavespestcontrol.com/newsletter-hero-1750000000000.jpg';
const DIVIDER_GIF = 'https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80/uploads/asset/file/952b11dc-99a2-4de3-8def-481a1c34f8d7/giphy.gif';
const GIPHY_GIF = 'https://media2.giphy.com/media/abc123/giphy.gif?cid=xyz';
const EVENT_PHOTO = 'https://cdn.evbuc.com/images/farmers-market.png';

function row(id, html) {
  return { id, subject: `Issue ${id}`, slug: null, sent_at: '2026-07-01T12:00:00Z', preview_text: 'preview', html_body: html, newsletter_type: null, indexability: 'index' };
}

test('hero image wins; GIFs (divider + giphy) never surface; event photos back-fill hero-less issues', async () => {
  mockRows = [
    // Standard issue: hero first, then intro GIF, divider, event photo.
    row(1, `<div><img src="${HERO}" alt="Fresh This Week" /></div>
            <img src="${GIPHY_GIF}" alt="" />
            <img src="${DIVIDER_GIF}" alt="" />
            <img src="${EVENT_PHOTO}" alt="market" />`),
    // Hero-less issue: GIFs first, event photo is the first non-GIF.
    row(2, `<img src="${GIPHY_GIF}" alt="" />
            <img src="${DIVIDER_GIF}" alt="" />
            <img src="${EVENT_PHOTO}" alt="market" />`),
    // All-GIF issue → no thumbnail.
    row(3, `<img src="${GIPHY_GIF}" alt="" /><img src="${DIVIDER_GIF}" alt="" />`),
    // No images at all → no thumbnail.
    row(4, '<p>text only</p>'),
  ];

  const posts = await getPublishedPosts({ limit: 10 });
  expect(posts.map((p) => p.image)).toEqual([HERO, EVENT_PHOTO, null, null]);
});

test('unsafe or malformed srcs are skipped, entity-encoded query strings are decoded', async () => {
  const QUERY_IMG = 'https://cdn.wavespestcontrol.com/hero.jpg?w=800&amp;h=600';
  mockRows = [
    // javascript:/relative/breakout srcs must never surface; the next clean
    // http(s) image wins instead.
    row(1, `<img src="javascript:alert(1)" />
            <img src="/relative/path.jpg" />
            <img src="https://cdn.wavespestcontrol.com/ok.jpg" />`),
    // &amp; in the attribute decodes to a working URL.
    row(2, `<img src="${QUERY_IMG}" />`),
    // A src with url(...) breakout characters is rejected → null.
    row(3, `<img src="https://cdn.wavespestcontrol.com/x.jpg\\"><style>" />`),
  ];

  const posts = await getPublishedPosts({ limit: 10 });
  expect(posts[0].image).toBe('https://cdn.wavespestcontrol.com/ok.jpg');
  expect(posts[1].image).toBe('https://cdn.wavespestcontrol.com/hero.jpg?w=800&h=600');
  expect(posts[2].image).toBeNull();

  // The rest of the post contract is untouched.
  expect(posts[0]).toMatchObject({
    title: 'Issue 1',
    link: '/newsletter/archive/1',
    source: 'newsletter',
    sourceName: 'Waves Newsletter',
  });
});
