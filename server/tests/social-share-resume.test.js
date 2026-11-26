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
const gbpService = require('../services/google-business');
const { WAVES_LOCATIONS } = require('../config/locations');

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
    // Facebook's result, then the in-flight mark for X saved before X was called.
    expect(savedAtX).toEqual([
      expect.objectContaining({ platform: 'facebook', postId: 'fb-new', success: true }),
      { platform: 'twitter', inFlight: true },
    ]);
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
  test('a second restart keeps a site the first attempt reached later in the order', async () => {
    // Attempt 1: Facebook failed, X succeeded. Attempt 2 retries Facebook (first in order)
    // and the progress write right after it must still carry the X success.
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([
        { platform: 'facebook', success: false, error: 'Facebook API 500' },
        { platform: 'twitter', postId: 'tw-early', success: true },
      ]) });
    const snapshots = [];
    const db = require('../models/db');
    const realImpl = db.getMockImplementation();
    db.mockImplementation((t) => {
      const b = realImpl(t);
      const update = b.update;
      b.update = async (cols) => { const n = await update(cols); if (cols.platforms_posted && !cols.status) snapshots.push(JSON.parse(cols.platforms_posted)); return n; };
      return b;
    });
    try {
      await share();
    } finally {
      db.mockImplementation(realImpl);
    }
    expect(xSpy).not.toHaveBeenCalled();
    // The progress write after Facebook's result still holds the X success.
    const afterFacebook = snapshots.find((snap) => snap.some((r) => r.platform === 'facebook' && r.success === true));
    expect(afterFacebook).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'facebook', postId: 'fb-new', success: true }),
      expect.objectContaining({ platform: 'twitter', postId: 'tw-early' }),
    ]));
  });

  test('a site cut off mid-post (in-flight mark, no result) is never posted again', async () => {
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'facebook', inFlight: true }]) });
    await share();
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(false);
    expect(xSpy).toHaveBeenCalledTimes(1);
    const pp = JSON.parse(mockRows[0].platforms_posted);
    expect(pp).toEqual(expect.arrayContaining([expect.objectContaining({ platform: 'facebook', inFlight: true, success: false })]));
  });

  test('a site with an in-flight mark AND a later result uses the result', async () => {
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'facebook', inFlight: true }, { platform: 'facebook', success: false, error: 'Facebook API 400' }]) });
    await share();
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(true);
  });

  test('when the share record cannot be read, nothing posts (the next run retries)', async () => {
    const db = require('../models/db');
    const realImpl = db.getMockImplementation();
    db.mockImplementation((t) => { const b = realImpl(t); b.first = async () => { throw new Error('connection reset'); }; return b; });
    let res;
    try {
      res = await share();
    } finally {
      db.mockImplementation(realImpl);
    }
    expect(res.success).toBe(false);
    expect(xSpy).not.toHaveBeenCalled();
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(false);
  });

  test('the admin Share button source (blog) resumes too', async () => {
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'facebook', postId: 'fb-early', success: true }]) });
    await share({ source: 'blog' });
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(false);
    expect(mockRows).toHaveLength(1);
  });

  test('a cut-off share is found by its feed GUID when the URL changed', async () => {
    mockRows.push({ id: 'row-old', source_url: 'https://www.wavespestcontrol.com/old-path/', source_guid: 'guid-1', source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'facebook', postId: 'fb-early', success: true }]) });
    await share({ guid: 'guid-1' });
    expect(global.fetch.mock.calls.some(([u]) => String(u).includes('/page-1/feed'))).toBe(false);
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].status).toBe('published');
    // Saved under the new URL, so a later URL-only lookup finds it.
    expect(mockRows[0].source_url).toBe(social.normalizeUrl(LINK));
  });

  test('a dry run never overwrites a cut-off live share', async () => {
    const saved = JSON.stringify([{ platform: 'facebook', postId: 'fb-early', success: true }]);
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing', platforms_posted: saved });
    process.env.SOCIAL_DRY_RUN = 'true';
    try {
      await share();
    } finally {
      delete process.env.SOCIAL_DRY_RUN;
    }
    expect(mockRows[0].status).toBe('publishing');
    expect(mockRows[0].platforms_posted).toBe(saved);
  });

  test('Google: an all-profiles run resumes only the profiles the cut-off attempt missed', async () => {
    process.env.SOCIAL_GBP_ENABLED = 'true';
    const locs = WAVES_LOCATIONS.filter((l) => l.googleLocationResourceName);
    expect(locs.length).toBeGreaterThan(1);
    mockRows.push({ id: 'row-old', source_url: social.normalizeUrl(LINK), source_type: 'rss', status: 'publishing',
      platforms_posted: JSON.stringify([{ platform: 'gbp', location: locs[0].id, postId: 'g-early', success: true }]) });
    const createSpy = jest.spyOn(gbpService, 'createPost').mockResolvedValue({ name: 'g-new' });
    try {
      await share({ channels: ['gbp'], customContent: { gbp: 'GBP copy' }, bypassAutoshareThrottle: true, gbpLocationIds: locs.map((l) => l.id) });
    } finally {
      delete process.env.SOCIAL_GBP_ENABLED;
    }
    const posted = createSpy.mock.calls.map(([name]) => name);
    expect(posted).not.toContain(locs[0].googleLocationResourceName);
    expect(posted).toHaveLength(locs.length - 1);
  });
});

