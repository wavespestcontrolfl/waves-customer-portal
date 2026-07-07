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
  });
  afterEach(() => {
    global.fetch = realFetch;
    linkedin.companyId = realCompanyId;
    jest.restoreAllMocks();
  });

  function mockRoutes({ initFails = false } = {}) {
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
      if (u === IMG) return { ok: true, arrayBuffer: async () => Buffer.from('jpeg-bytes').buffer.slice(0), text: async () => '' };
      if (u === 'https://upload.example.com/u1') return { ok: true, text: async () => '' };
      if (u.startsWith('https://api.linkedin.com/rest/posts')) {
        return { ok: true, headers: { get: () => 'post-1' }, text: async () => '' };
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    return calls;
  }

  test('uploads the image binary and sets content.article.thumbnail to the image URN', async () => {
    const calls = mockRoutes();

    const res = await linkedin.createPost({ text: 'T', link: LINK, title: 'Title', description: 'Desc', imageUrl: IMG });

    expect(res).toMatchObject({ platform: 'linkedin', success: true });
    expect(calls.some((c) => c.url === 'https://upload.example.com/u1' && c.method === 'PUT')).toBe(true);
    const postBody = JSON.parse(calls.find((c) => c.url.startsWith('https://api.linkedin.com/rest/posts')).body);
    expect(postBody.content.article).toMatchObject({ source: LINK, thumbnail: 'urn:li:image:abc' });
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
