const linkedin = require('../services/linkedin');

const { parseJsonObject, SCOPES, API_VERSION } = linkedin._test;

describe('linkedin service config', () => {
  test('API_VERSION is a current YYYYMM (not the stale placeholder)', () => {
    expect(API_VERSION).toMatch(/^20\d{4}$/);
    // LinkedIn sunsets monthly versions; guard against regressing to an old one.
    expect(Number(API_VERSION)).toBeGreaterThanOrEqual(202507);
  });

  test('SCOPES request ORGANIZATION posting, not member', () => {
    expect(SCOPES).toContain('w_organization_social');
    expect(SCOPES).not.toContain('w_member_social');
  });

  test('parseJsonObject tolerates objects, strings, and garbage', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject({ a: 1 })).toEqual({ a: 1 });
    expect(parseJsonObject('not json')).toEqual({});
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonObject('[1,2]')).toEqual({}); // arrays are not token records
  });
});

describe('linkedin service surface', () => {
  test('exposes the OAuth + posting methods', () => {
    for (const m of ['getAuthUrl', 'handleCallback', 'storeTokens', 'getStatus', 'createPost', 'verifyOrgAccess']) {
      expect(typeof linkedin[m]).toBe('function');
    }
  });

  test('getAuthUrl builds a LinkedIn consent URL with our scopes + redirect', () => {
    // getAuthUrl needs a client id; only assert when configured (env-dependent).
    if (!linkedin.clientId) return;
    const url = linkedin.getAuthUrl('abc123');
    expect(url).toContain('https://www.linkedin.com/oauth/v2/authorization');
    expect(url).toContain('response_type=code');
    expect(url).toContain('state=abc123');
    expect(url).toContain(encodeURIComponent('w_organization_social'));
    expect(url).toContain(encodeURIComponent('/api/admin/settings/linkedin/callback'));
  });
});

// LinkedIn does NOT scrape article URLs — without an uploaded thumbnail the
// article card renders with no picture (live gap the owner flagged 2026-07-06).
// createPost now rehosts imageUrl via the Images API (initializeUpload → PUT
// binary → urn:li:image:…) and sets it as content.article.thumbnail.
describe('createPost article thumbnail (Images API)', () => {
  const realFetch = global.fetch;
  const realCompanyId = linkedin.companyId;
  const LINK = 'https://www.wavespestcontrol.com/pest-control/lizard-droppings/';
  const IMG = 'https://cdn.example.com/social-media/blog-hero-lizard.jpg';

  beforeEach(() => {
    jest.spyOn(linkedin, '_getValidAccessToken').mockResolvedValue('tok');
    linkedin.companyId = '123';
    process.env.SOCIAL_MEDIA_CDN_DOMAIN = 'cdn.example.com';
  });
  afterEach(() => {
    global.fetch = realFetch;
    linkedin.companyId = realCompanyId;
    delete process.env.SOCIAL_MEDIA_CDN_DOMAIN;
    jest.restoreAllMocks();
  });

  // Default fixture leads with the JPEG magic bytes so the format sniff
  // treats it as an accepted format and skips the sharp conversion.
  function mockRoutes({ initFails = false, imageStatus = 'AVAILABLE', imageBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-bytes')]) } = {}) {
    const calls = [];
    global.fetch = jest.fn(async (url, opts = {}) => {
      const u = String(url);
      calls.push({ url: u, method: opts.method || 'GET', body: typeof opts.body === 'string' ? opts.body : null });
      if (u.startsWith('https://api.linkedin.com/rest/images?action=initializeUpload')) {
        if (initFails) return { ok: false, status: 500, text: async () => 'boom' };
        return {
          ok: true,
          json: async () => ({ value: { uploadUrl: 'https://upload.example.com/u1', image: 'urn:li:image:abc' } }),
          text: async () => '',
        };
      }
      if (u.startsWith('https://api.linkedin.com/rest/images/')) {
        return { ok: true, json: async () => ({ status: imageStatus }), text: async () => '' };
      }
      if (u === IMG) {
        return {
          ok: true,
          headers: { get: (h) => (h === 'content-length' ? String(imageBytes.length) : null) },
          arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.length),
          text: async () => '',
        };
      }
      if (u === 'https://upload.example.com/u1') return { ok: true, text: async () => '' };
      if (u.startsWith('https://api.linkedin.com/rest/posts')) {
        return { ok: true, headers: { get: () => 'post-1' }, text: async () => '' };
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    return calls;
  }

  test('uploads the image binary, waits for AVAILABLE, and sets content.article.thumbnail to the image URN', async () => {
    const calls = mockRoutes();

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', description: 'Desc', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    expect(calls.some((c) => c.url === 'https://upload.example.com/u1' && c.method === 'PUT')).toBe(true);
    // Ingestion is async — the status poll must run before the post is created.
    expect(calls.some((c) => c.url.startsWith('https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3Aabc'))).toBe(true);
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article).toMatchObject({ source: LINK, thumbnail: 'urn:li:image:abc' });
  });

  test('image processing FAILED → posts without a thumbnail (best-effort)', async () => {
    const calls = mockRoutes({ imageStatus: 'PROCESSING_FAILED' });

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.thumbnail).toBeUndefined();
  });

  test('untrusted imageUrl host (SSRF guard) → no fetch of the URL, posts without a thumbnail', async () => {
    const calls = mockRoutes();

    const res = await linkedin.createPost({
      text: 'T', link: LINK, title: 'Title',
      imageUrl: 'https://169.254.169.254/latest/meta-data/',
    });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    expect(calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/rest/images'))).toBe(false);
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.thumbnail).toBeUndefined();
  });

  test('thumbnail fetch refuses redirects (redirect: "error") — a trusted host 302-ing to a private address must not be followed', async () => {
    const calls = mockRoutes();

    await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    const imgFetch = global.fetch.mock.calls.find(([u]) => String(u) === IMG);
    expect(imgFetch[1].redirect).toBe('error');
    expect(calls.some((c) => c.url === IMG)).toBe(true);
  });

  test('oversized thumbnail (declared Content-Length) is refused — posts without a thumbnail', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    const calls = mockRoutes({ imageBytes: big });

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.thumbnail).toBeUndefined();
  });

  test('a streamed body that omits Content-Length is capped MID-READ (aborts past 10MB, posts without a thumbnail)', async () => {
    const calls = mockRoutes();
    // Override the image route with a body stream that never declares a
    // length and keeps producing 1MB chunks — the cap must fire during the
    // read, not after buffering completes (the stream would never end).
    const inner = global.fetch;
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url) === IMG) {
        const chunk = new Uint8Array(1024 * 1024);
        return {
          ok: true,
          headers: { get: () => null }, // no content-length
          body: { getReader: () => ({ read: async () => ({ done: false, value: chunk }) }) },
        };
      }
      return inner(url, opts);
    });

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.thumbnail).toBeUndefined();
  });

  test('_isTrustedImageUrl allows only https on the CDN or wavespestcontrol.com hosts', () => {
    expect(linkedin._isTrustedImageUrl('https://cdn.example.com/x.jpg')).toBe(true);
    expect(linkedin._isTrustedImageUrl('https://www.wavespestcontrol.com/images/hero.webp')).toBe(true);
    expect(linkedin._isTrustedImageUrl('http://cdn.example.com/x.jpg')).toBe(false); // not https
    expect(linkedin._isTrustedImageUrl('https://localhost/x.jpg')).toBe(false);
    expect(linkedin._isTrustedImageUrl('https://evil.example.com/x.jpg')).toBe(false);
    expect(linkedin._isTrustedImageUrl('https://notwavespestcontrol.com/x.jpg')).toBe(false);
    expect(linkedin._isTrustedImageUrl('not a url')).toBe(false);
  });

  test('_isLinkedinAcceptedImage sniffs magic bytes: JPEG/PNG/GIF pass, WebP does not', async () => {
    const sharp = require('sharp');
    const px = { create: { width: 4, height: 4, channels: 3, background: { r: 4, g: 57, b: 94 } } };
    expect(linkedin._isLinkedinAcceptedImage(await sharp(px).jpeg().toBuffer())).toBe(true);
    expect(linkedin._isLinkedinAcceptedImage(await sharp(px).png().toBuffer())).toBe(true);
    expect(linkedin._isLinkedinAcceptedImage(await sharp(px).gif().toBuffer())).toBe(true);
    expect(linkedin._isLinkedinAcceptedImage(await sharp(px).webp().toBuffer())).toBe(false);
    expect(linkedin._isLinkedinAcceptedImage(Buffer.from('nope'))).toBe(false);
    expect(linkedin._isLinkedinAcceptedImage(Buffer.alloc(0))).toBe(false);
  });

  test('a WebP thumbnail (published .webp blog hero) is converted to JPEG before the PUT — LinkedIn rejects WebP', async () => {
    const sharp = require('sharp');
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 4, g: 57, b: 94 } } })
      .webp().toBuffer();
    const calls = mockRoutes({ imageBytes: webp });

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    const put = global.fetch.mock.calls.find(([u, o]) => String(u) === 'https://upload.example.com/u1' && o?.method === 'PUT');
    expect(put).toBeTruthy();
    const sent = put[1].body;
    // JPEG magic bytes — the webp must not reach LinkedIn unconverted.
    expect(sent[0]).toBe(0xff);
    expect(sent[1]).toBe(0xd8);
    expect(sent[2]).toBe(0xff);
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.thumbnail).toBe('urn:li:image:abc');
  });

  test('a JPEG thumbnail uploads byte-for-byte unconverted', async () => {
    const sharp = require('sharp');
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 4, g: 57, b: 94 } } })
      .jpeg().toBuffer();
    mockRoutes({ imageBytes: jpeg });

    await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    const put = global.fetch.mock.calls.find(([u, o]) => String(u) === 'https://upload.example.com/u1' && o?.method === 'PUT');
    expect(Buffer.compare(put[1].body, jpeg)).toBe(0);
  });

  test('a thumbnail failure never blocks the post — it publishes without an image (best-effort)', async () => {
    const calls = mockRoutes({ initFails: true });

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article.source).toBe(LINK);
    expect(postBody.content.article.thumbnail).toBeUndefined();
  });

  test('no imageUrl → no Images API traffic at all (unchanged text+article post)', async () => {
    const calls = mockRoutes();

    await linkedin.createPost({ text: 'T', link: LINK, title: 'Title' });

    expect(calls.some((c) => c.url.includes('/rest/images'))).toBe(false);
    expect(calls.some((c) => c.url.startsWith('https://api.linkedin.com/rest/posts'))).toBe(true);
  });
});
