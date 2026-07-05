// Blog-post shares carry the post's OWN hero image (owner directive
// 2026-07-05): blogHeroSocialImageUrl resolves the live page's og:image and
// re-hosts it through uploadImageToS3 (webp → JPEG — Instagram's Graph API
// only accepts JPEG). Any miss returns null so callers fall back to the
// brand card; non-hub links never fetch at all.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({
  s3: { accessKeyId: 'ak', secretAccessKey: 'sk', bucket: 'bkt', region: 'us-east-1' },
}));
const mockS3Send = jest.fn().mockResolvedValue({});
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn((params) => params),
}));
jest.mock('sharp', () => jest.fn(() => ({
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
})));

const social = require('../services/social-media');

const PAGE = 'https://www.wavespestcontrol.com/pest-control/dangerous-ants-in-florida/';
const HERO = 'https://www.wavespestcontrol.com/images/blog/dangerous-ants-in-florida/hero.webp';
const HTML = `<html><head><meta property="og:image" content="${HERO}"></head><body/></html>`;

function mockFetch(routes) {
  global.fetch = jest.fn(async (url) => {
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: route.ok !== false,
      text: async () => route.text || '',
      arrayBuffer: async () => (route.bytes || Buffer.alloc(0)).buffer.slice(0),
    };
  });
}

describe('blogHeroSocialImageUrl', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.SOCIAL_MEDIA_CDN_DOMAIN = 'cdn.example.com';
    mockS3Send.mockClear();
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SOCIAL_MEDIA_CDN_DOMAIN;
    jest.clearAllMocks();
  });

  test('resolves og:image, re-hosts as JPEG on the CDN, keys the file by the post slug', async () => {
    mockFetch({
      [PAGE]: { text: HTML },
      [HERO]: { bytes: Buffer.from('webp-bytes') },
    });

    const url = await social.blogHeroSocialImageUrl(PAGE);

    expect(url).toMatch(/^https:\/\/cdn\.example\.com\/social-media\/blog-hero-dangerous-ants-in-florida-\d+\.jpg$/);
    // The upload went through the JPEG-converting S3 path (Instagram requires JPEG).
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0]).toMatchObject({ ContentType: 'image/jpeg' });
    expect(require('sharp')).toHaveBeenCalled();
  });

  test('handles reversed og:image attribute order (content before property)', async () => {
    mockFetch({
      [PAGE]: { text: `<meta content="${HERO}" property="og:image">` },
      [HERO]: { bytes: Buffer.from('webp-bytes') },
    });

    await expect(social.blogHeroSocialImageUrl(PAGE)).resolves.toMatch(/blog-hero-dangerous-ants/);
  });

  test('non-hub links return null WITHOUT fetching (spoke/foreign URLs keep the brand card)', async () => {
    global.fetch = jest.fn();

    await expect(social.blogHeroSocialImageUrl('https://sarasotaflpestcontrol.com/pest-control/x/')).resolves.toBeNull();
    await expect(social.blogHeroSocialImageUrl('https://evil.example.com/')).resolves.toBeNull();
    await expect(social.blogHeroSocialImageUrl(null)).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('page without og:image, non-200 page, and empty image body all return null (card fallback)', async () => {
    mockFetch({ [PAGE]: { text: '<html><head></head></html>' } });
    await expect(social.blogHeroSocialImageUrl(PAGE)).resolves.toBeNull();

    mockFetch({ [PAGE]: { ok: false } });
    await expect(social.blogHeroSocialImageUrl(PAGE)).resolves.toBeNull();

    mockFetch({ [PAGE]: { text: HTML }, [HERO]: { bytes: Buffer.alloc(0) } });
    await expect(social.blogHeroSocialImageUrl(PAGE)).resolves.toBeNull();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('fetch failure is swallowed to null, never thrown into the share path', async () => {
    global.fetch = jest.fn(async () => { throw new Error('boom'); });

    await expect(social.blogHeroSocialImageUrl(PAGE)).resolves.toBeNull();
  });

  test('BLOG_HERO_SOURCES covers exactly the blog-share lanes (poller, RSS backstop, scheduler)', () => {
    expect(social.BLOG_HERO_SOURCES).toEqual(new Set(['autonomous_blog', 'rss', 'blog_scheduled']));
    // newsletter/studio/manual shares keep the brand card
    expect(social.BLOG_HERO_SOURCES.has('newsletter')).toBe(false);
    expect(social.BLOG_HERO_SOURCES.has('scheduled')).toBe(false);
    expect(social.BLOG_HERO_SOURCES.has('manual')).toBe(false);
  });

  test('scheduler blog share passes NO imageUrl — a raw .webp hero would bypass the hero branch and fail Instagram (Codex round 1)', () => {
    // publishToAll seeds generatedImageUrl from a caller-passed imageUrl, and
    // the hero branch only runs when generatedImageUrl is empty — so the
    // blog_scheduled caller must let publishToAll own image resolution.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/content-scheduler.js'), 'utf8');
    const sourceIdx = src.indexOf("source: 'blog_scheduled'");
    expect(sourceIdx).toBeGreaterThan(-1);
    const callStart = src.lastIndexOf('publishToAll({', sourceIdx);
    const callEnd = src.indexOf('});', sourceIdx);
    expect(callStart).toBeGreaterThan(-1);
    const call = src.slice(callStart, callEnd);
    // Property position only — the explanatory comment inside the call
    // legitimately mentions "imageUrl:".
    expect(call).not.toMatch(/^\s*imageUrl\s*:/m);
  });
});
