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
jest.mock('../services/linkedin', () => ({
  configured: true,
  companyId: '123',
  getStatus: async () => ({ connected: true }),
}));

// FACEBOOK_PAGE_ID / INSTAGRAM_ACCOUNT_ID are read at module load — set them
// BEFORE the require so the publishToAll platform-readiness checks pass.
process.env.FACEBOOK_PAGE_ID = 'page-1';
process.env.INSTAGRAM_ACCOUNT_ID = 'ig-acct';

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

  test('BLOG_HERO_SOURCES covers exactly the blog-share lanes (poller, RSS backstop, scheduler, admin share button)', () => {
    expect(social.BLOG_HERO_SOURCES).toEqual(new Set(['autonomous_blog', 'rss', 'blog_scheduled', 'blog']));
    // newsletter/studio/manual-url shares keep the brand card
    expect(social.BLOG_HERO_SOURCES.has('newsletter')).toBe(false);
    expect(social.BLOG_HERO_SOURCES.has('scheduled')).toBe(false);
    expect(social.BLOG_HERO_SOURCES.has('manual')).toBe(false);
  });

  test("the admin BlogPage share route (source 'blog') gets the FB link-post treatment too", () => {
    // The manual share button passes source:'blog' + an imageUrl — Facebook
    // must still post text+link, not /photos with the raw URL in the caption.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../routes/admin-content-v2.js'), 'utf8');
    expect(src).toContain("source: 'blog'");
    expect(social.BLOG_HERO_SOURCES.has('blog')).toBe(true);
  });

  describe('linkedinWantsBlogHero (LinkedIn cannot scrape article URLs — the hero must be uploaded as a thumbnail)', () => {
    const base = {
      requestedPlatforms: new Set(['linkedin']),
      source: 'autonomous_blog',
      noAiImage: true,
      hasVideo: false,
    };
    beforeEach(() => {
      process.env.SOCIAL_LINKEDIN_ENABLED = 'true';
      require('../services/linkedin').configured = true;
      require('../services/linkedin').companyId = '123';
    });
    afterEach(() => {
      delete process.env.SOCIAL_LINKEDIN_ENABLED;
      require('../services/linkedin').configured = true;
      require('../services/linkedin').companyId = '123';
    });

    test('true for a LinkedIn-only blog share (no Instagram/GBP needed)', () => {
      expect(social.linkedinWantsBlogHero(base)).toBe(true);
    });

    test('false for every non-hero condition: non-blog source, video, AI path, LinkedIn not requested/enabled/configured, no company id', () => {
      expect(social.linkedinWantsBlogHero({ ...base, source: 'newsletter' })).toBe(false);
      expect(social.linkedinWantsBlogHero({ ...base, hasVideo: true })).toBe(false);
      expect(social.linkedinWantsBlogHero({ ...base, noAiImage: false })).toBe(false);
      expect(social.linkedinWantsBlogHero({ ...base, requestedPlatforms: new Set(['facebook']) })).toBe(false);
      process.env.SOCIAL_LINKEDIN_ENABLED = 'false';
      expect(social.linkedinWantsBlogHero(base)).toBe(false);
      process.env.SOCIAL_LINKEDIN_ENABLED = 'true';
      require('../services/linkedin').configured = false;
      expect(social.linkedinWantsBlogHero(base)).toBe(false);
      require('../services/linkedin').configured = true;
      require('../services/linkedin').companyId = null;
      expect(social.linkedinWantsBlogHero(base)).toBe(false);
    });
  });

  describe('Facebook blog shares post as /feed LINK posts, never /photos (owner directive 2026-07-06: embedded preview, no raw URL in the caption)', () => {
    beforeEach(() => {
      process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
      process.env.SOCIAL_FACEBOOK_ENABLED = 'true';
      process.env.FACEBOOK_ACCESS_TOKEN = 'tok';
    });
    afterEach(() => {
      delete process.env.SOCIAL_AUTOMATION_ENABLED;
      delete process.env.SOCIAL_FACEBOOK_ENABLED;
      delete process.env.FACEBOOK_ACCESS_TOKEN;
    });

    function mockGraph() {
      const calls = [];
      global.fetch = jest.fn(async (url, opts = {}) => {
        calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
        return { ok: true, json: async () => ({ id: 'fb-1', post_id: 'fb-1' }), text: async () => '' };
      });
      return calls;
    }

    test('blog share with an image still posts text+link to /feed — the preview card carries the hero (og:image)', async () => {
      const calls = mockGraph();

      const res = await social.publishToAll({
        title: 'T', description: 'D', link: PAGE, source: 'autonomous_blog',
        imageUrl: 'https://cdn.example.com/social-media/blog-hero-x.jpg',
        channels: ['facebook'], customContent: { facebook: 'Lizard droppings caption' },
        noAiImage: true,
      });

      expect(res.platforms).toEqual([expect.objectContaining({ platform: 'facebook', success: true })]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/page-1/feed');
      expect(calls[0].body).toMatchObject({ message: 'Lizard droppings caption', link: PAGE });
      // The caption must NOT have the raw URL pasted into it.
      expect(calls[0].body.message).not.toContain('https://');
    });

    test('non-blog sources with an image keep the /photos post (caption carries the link — unchanged behavior)', async () => {
      const calls = mockGraph();

      await social.publishToAll({
        title: 'T', description: 'D', link: PAGE, source: 'studio',
        imageUrl: 'https://cdn.example.com/social-media/campaign.jpg',
        channels: ['facebook'], customContent: { facebook: 'Campaign caption' },
        noAiImage: true,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/page-1/photos');
      expect(calls[0].body.caption).toContain('Campaign caption');
      expect(calls[0].body.caption).toContain(PAGE);
    });

    test('Instagram blog shares get the article URL appended to the caption (owner directive 2026-07-06; plain text — IG captions are not clickable)', async () => {
      process.env.SOCIAL_INSTAGRAM_ENABLED = 'true';
      const calls = [];
      global.fetch = jest.fn(async (url, opts = {}) => {
        const u = String(url);
        calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
        if (u.includes('/ig-acct/media_publish')) return { ok: true, json: async () => ({ id: 'ig-post-1' }), text: async () => '' };
        if (u.includes('/ig-acct/media')) return { ok: true, json: async () => ({ id: 'container-1' }), text: async () => '' };
        if (u.includes('container-1?fields=')) return { ok: true, json: async () => ({ status_code: 'FINISHED' }), text: async () => '' };
        throw new Error(`unexpected fetch: ${u}`);
      });

      try {
        const res = await social.publishToAll({
          title: 'T', description: 'D', link: PAGE, source: 'autonomous_blog',
          imageUrl: 'https://cdn.example.com/social-media/blog-hero-x.jpg',
          channels: ['instagram'], customContent: { instagram: 'IG caption\n\n#wavespestcontrol' },
          noAiImage: true,
        });

        expect(res.platforms).toEqual([expect.objectContaining({ platform: 'instagram', success: true })]);
        const containerCall = calls.find((c) => c.url.includes('/ig-acct/media') && !c.url.includes('media_publish'));
        expect(containerCall.body.caption).toBe(`IG caption\n\n#wavespestcontrol\n\n${PAGE}`);

        // A near-limit caption must be trimmed (caption, never the URL) so the
        // append cannot push the publish request over Instagram's 2200 limit.
        calls.length = 0;
        await social.publishToAll({
          title: 'T', description: 'D', link: PAGE, source: 'autonomous_blog',
          imageUrl: 'https://cdn.example.com/social-media/blog-hero-x.jpg',
          channels: ['instagram'], customContent: { instagram: 'y'.repeat(2190) },
          noAiImage: true,
        });
        const longCall = calls.find((c) => c.url.includes('/ig-acct/media') && !c.url.includes('media_publish'));
        expect(longCall.body.caption.length).toBeLessThanOrEqual(2200);
        expect(longCall.body.caption.endsWith(`\n\n${PAGE}`)).toBe(true);
        expect(longCall.body.caption).toContain('…');
      } finally {
        delete process.env.SOCIAL_INSTAGRAM_ENABLED;
      }
    }, 30000);
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
