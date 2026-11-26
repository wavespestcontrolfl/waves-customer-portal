// A blog share a restart cuts off mid-run must not post the article twice.
// The locked lanes write a 'publishing' row before the first site and record
// each site's result as it lands; a later run finishes only the missing sites
// (Facebook got the same article twice on 2026-10-24, 11-19 and 11-24).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));

// In-memory social_media_posts with the few builder calls publishToAll uses.
const mockRows = [];
jest.mock('../models/db', () => {
  const make = (table) => {
    const filters = [];
    const b = {
      where(col, val) { if (typeof col === 'string') filters.push((r) => r[col] === val); return b; },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return b; },
      whereNotIn(col, vals) { filters.push((r) => !vals.includes(r[col])); return b; },
      whereRaw() { return b; },
      orderBy() { return b; },
      select() { return b; },
      count() { return Promise.resolve([{ count: 0 }]); },
      first: async () => (table === 'social_media_posts' ? mockRows.filter((r) => filters.every((f) => f(r))).slice(-1)[0] : undefined),
      update: async (cols) => {
        const hit = mockRows.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, cols));
        return hit.length;
      },
      insert: (row) => {
        const r = { id: `row-${mockRows.length + 1}`, created_at: new Date(), ...row };
        if (table === 'social_media_posts') mockRows.push(r);
        const p = Promise.resolve([r.id]);
        p.returning = async () => [{ id: r.id }];
        return p;
      },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return b;
  };
  const fn = jest.fn((t) => make(t));
  fn.raw = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});

process.env.FACEBOOK_PAGE_ID = 'page-1';
const social = require('../services/social-media');
const twitter = require('../services/twitter');

const LINK = 'https://www.wavespestcontrol.com/pest-control/what-odor-do-mice-hate/';

function share(extra = {}) {
  return social.publishToAll({
    title: 'T', description: 'D', link: LINK, guid: LINK, source: 'rss',
    channels: ['facebook', 'twitter'], customContent: { facebook: 'FB caption', twitter: 'X caption' },
    noAiImage: true, trackProgress: true, ...extra,
  });
}

describe('cut-off blog share resumes without posting twice', () => {
  let xSpy;
  beforeEach(() => {
    mockRows.length = 0;
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
    process.env.SOCIAL_FACEBOOK_ENABLED = 'true';
    process.env.SOCIAL_TWITTER_ENABLED = 'true';
    process.env.FACEBOOK_ACCESS_TOKEN = 'tok';
    process.env.ZERNIO_API_KEY = 'zk';
    process.env.SOCIAL_AUTOSHARE_DAILY_CAP = '0';
    process.env.FACEBOOK_PREVIEW_SETTLE_MS = '0';
    social._resetFacebookPreviewReads();
    xSpy = jest.spyOn(twitter, 'createPost').mockResolvedValue({ platform: 'twitter', postId: 'tw-1', success: true });
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ id: 'fb-new' }), text: async () => '' }));
  });
  afterEach(() => {
    for (const k of ['SOCIAL_AUTOMATION_ENABLED', 'SOCIAL_FACEBOOK_ENABLED', 'SOCIAL_TWITTER_ENABLED', 'FACEBOOK_ACCESS_TOKEN', 'ZERNIO_API_KEY', 'SOCIAL_AUTOSHARE_DAILY_CAP', 'FACEBOOK_PREVIEW_SETTLE_MS']) delete process.env[k];
    jest.restoreAllMocks();
  });

  test('a fresh share writes a publishing row first, then finishes it as published', async () => {
    let statusAtX = null;
    xSpy.mockImplementation(async () => { statusAtX = mockRows[0] && mockRows[0].status; return { platform: 'twitter', postId: 'tw-1', success: true }; });
    const res = await share();
    expect(res.success).toBe(true);
    expect(statusAtX).toBe('publishing');
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].status).toBe('published');
    const pp = JSON.parse(mockRows[0].platforms_posted);
    expect(pp.map((p) => p.platform)).toEqual(['facebook', 'twitter']);
  });

  test('Facebook already went out before the restart: only X posts now, on the same row', async () => {
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'facebook', postId: 'fb-early', success: true }]) });
    const res = await share();
    expect(res.success).toBe(true);
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(false);
    expect(xSpy).toHaveBeenCalledTimes(1);
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].status).toBe('published');
    const pp = JSON.parse(mockRows[0].platforms_posted);
    expect(pp).toEqual([
      expect.objectContaining({ platform: 'facebook', postId: 'fb-early', resumed: true }),
      expect.objectContaining({ platform: 'twitter', postId: 'tw-1' }),
    ]);
  });

  test('each site result is saved as it lands (a restart after Facebook keeps that record)', async () => {
    let savedAtX = null;
    xSpy.mockImplementation(async () => { savedAtX = JSON.parse(mockRows[0].platforms_posted); throw new Error('process killed'); });
    await share();
    expect(savedAtX).toEqual([expect.objectContaining({ platform: 'facebook', postId: 'fb-new', success: true })]);
  });

  test('an earlier failed row is reused, not duplicated', async () => {
    mockRows.push({ id: 'row-failed', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'failed', platforms_posted: '[]' });
    await share();
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].status).toBe('published');
  });

  test('without trackProgress (other lanes) nothing changes: no publishing row', async () => {
    let statusAtX = 'none';
    xSpy.mockImplementation(async () => { statusAtX = mockRows.length ? mockRows[0].status : 'none'; return { platform: 'twitter', postId: 'tw-1', success: true }; });
    await share({ trackProgress: false });
    expect(statusAtX).toBe('none');
  });
});
