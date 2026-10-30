/**
 * Admin social-media RSS + analytics (audit 2026-10-30, SOC-04/05/08):
 *  - SOC-08: GET /rss and POST /check-rss always use the fixed blog feed; a
 *    caller-supplied ?url= / feedUrl never reaches the service.
 *  - SOC-05: checkAndPublish reports true published / skipped / failed counts.
 *  - SOC-04: GET /analytics classifies each platform from its own outcome.
 * Every provider and the db are mocked; nothing is posted or fetched.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: 'staff-1', role: 'admin' };
      req.technicianId = 'staff-1';
      req.techRole = 'admin';
      return next();
    },
  };
});
jest.mock('../services/linkedin', () => ({ getStatus: jest.fn() }));
jest.mock('../services/social-content-studio', () => ({ AUTONOMOUS_FLAGS: { enabled: true } }));
jest.mock('../services/social-engagement', () => ({
  engagementByPost: jest.fn(async () => ({})),
  syncRecentEngagement: jest.fn(),
}));

let mockPosts = [];
const mockDb = jest.fn(() => {
  const builder = {
    where: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(mockPosts)),
    first: jest.fn(() => Promise.resolve(null)),
  };
  return builder;
});
jest.mock('../models/db', () => mockDb);

const express = require('express');
const SocialMediaService = require('../services/social-media');
const router = require('../routes/admin-social-media');

const FEED = 'https://www.wavespestcontrol.com/feed.xml';

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/social-media', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('SOC-08: RSS routes use the fixed feed only', () => {
  let rssSpy;
  let checkSpy;
  beforeEach(() => {
    rssSpy = jest.spyOn(SocialMediaService, 'getRSSItems').mockResolvedValue([]);
    checkSpy = jest.spyOn(SocialMediaService, 'checkAndPublish')
      .mockResolvedValue({ processed: 0, published: 0, skipped: 0, failed: 0, results: [] });
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('GET /rss ignores ?url= and reads the fixed feed', async () => {
    const res = await call('GET', `/api/admin/social-media/rss?url=${encodeURIComponent('http://127.0.0.1:9/x')}`);
    expect(res.status).toBe(200);
    expect(rssSpy).toHaveBeenCalledTimes(1);
    expect(rssSpy).toHaveBeenCalledWith(FEED);
    expect(res.body.feedUrl).toBe(FEED);
  });

  test('POST /check-rss ignores body feedUrl and checks the fixed feed', async () => {
    const res = await call('POST', '/api/admin/social-media/check-rss', { feedUrl: 'http://127.0.0.1:9/x' });
    expect(res.status).toBe(200);
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(checkSpy).toHaveBeenCalledWith(FEED, { manual: true });
  });

  test('the service default and the exported constant are the same feed', () => {
    expect(SocialMediaService.RSS_FEED_URL).toBe(FEED);
  });
});

describe('SOC-05: rssItemOutcome classifies each item result', () => {
  const { rssItemOutcome } = SocialMediaService;
  test('success is published; a dry run that reports success is skipped', () => {
    expect(rssItemOutcome({ success: true, platforms: [{ platform: 'facebook', success: true }] })).toBe('published');
    expect(rssItemOutcome({ success: true, dryRun: true, platforms: [] })).toBe('skipped');
  });
  test('all platforms skipped is skipped, even a compliance-judge skip that carries an error', () => {
    expect(rssItemOutcome({ success: false, platforms: [{ platform: 'all', skipped: 'Automation is paused' }] })).toBe('skipped');
    expect(rssItemOutcome({
      success: false,
      platforms: [{ platform: 'linkedin', success: false, skipped: true, error: 'Compliance judge: x' }],
    })).toBe('skipped');
  });
  test('a thrown item or an unsuccessful platform error is failed', () => {
    expect(rssItemOutcome({ error: 'boom' })).toBe('failed');
    expect(rssItemOutcome({
      success: false,
      platforms: [{ platform: 'facebook', success: false, error: 'token expired' }, { platform: 'gbp', skipped: 'Disabled' }],
    })).toBe('failed');
  });
});

describe('SOC-05: checkAndPublish returns true counts', () => {
  const db = require('../models/db');
  const feedXml = (n) => `<rss><channel>${Array.from({ length: n }, (_, i) => (
    `<item><title>Post ${i}</title><link>https://www.wavespestcontrol.com/post-${i}/</link>`
    + `<description>Body ${i}</description><guid>guid-${i}</guid></item>`)).join('')}</channel></rss>`;

  function arrange(n, publishResults) {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => feedXml(n) });
    const trx = Object.assign(jest.fn(() => {
      const b = { where: jest.fn(() => b), whereNotIn: jest.fn(() => b), select: jest.fn(async () => []) };
      return b;
    }), { raw: jest.fn(async () => ({ rows: [{ locked: true }] })) });
    db.transaction = jest.fn(async (fn) => fn(trx));
    const pub = jest.spyOn(SocialMediaService, 'publishToAll');
    publishResults.forEach((r) => (r instanceof Error ? pub.mockRejectedValueOnce(r) : pub.mockResolvedValueOnce(r)));
    return pub;
  }
  afterEach(() => { jest.restoreAllMocks(); });

  const skippedOnly = { success: false, dryRun: false, platforms: [{ platform: 'all', skipped: 'Automation is paused' }] };
  const failedOnly = { success: false, dryRun: false, platforms: [{ platform: 'facebook', success: false, error: 'token expired' }] };
  const ok = { success: true, dryRun: false, platforms: [{ platform: 'facebook', success: true }] };

  test('skipped-only fixture: 0 published, 1 skipped', async () => {
    arrange(1, [skippedOnly]);
    const r = await SocialMediaService.checkAndPublish(undefined, { manual: true });
    expect(r).toMatchObject({ processed: 1, published: 0, skipped: 1, failed: 0 });
  });

  test('failed fixture: 0 published, 1 failed', async () => {
    arrange(1, [failedOnly]);
    const r = await SocialMediaService.checkAndPublish(undefined, { manual: true });
    expect(r).toMatchObject({ processed: 1, published: 0, skipped: 0, failed: 1 });
  });

  test('mixed fixture: published, skipped, failed and a thrown item', async () => {
    arrange(4, [ok, skippedOnly, failedOnly, new Error('render failed')]);
    const r = await SocialMediaService.checkAndPublish(undefined, { manual: true });
    expect(r).toMatchObject({ processed: 4, published: 1, skipped: 1, failed: 2 });
    expect(r.results).toHaveLength(4);
  });

  test('an empty feed still carries the three counts', async () => {
    arrange(0, []);
    const r = await SocialMediaService.checkAndPublish(undefined, { manual: true });
    expect(r).toMatchObject({ processed: 0, published: 0, skipped: 0, failed: 0 });
  });
});

describe('SOC-04: /analytics classifies platforms from their own outcome', () => {
  test('published post: Facebook success, Instagram failure, LinkedIn skipped', async () => {
    mockPosts = [{
      id: 1,
      title: 'Synthetic post',
      status: 'published',
      created_at: new Date().toISOString(),
      platforms_posted: JSON.stringify([
        { platform: 'facebook', success: true },
        { platform: 'instagram', success: false, error: 'permission' },
        { platform: 'linkedin', skipped: 'Disabled' },
      ]),
    }];
    const res = await call('GET', '/api/admin/social-media/analytics');
    expect(res.status).toBe(200);
    const { byPlatform, summary } = res.body;
    expect(byPlatform.facebook).toMatchObject({ total: 1, success: 1, failed: 0, skipped: 0 });
    expect(byPlatform.instagram).toMatchObject({ total: 1, success: 0, failed: 1, skipped: 0 });
    expect(byPlatform.linkedin).toMatchObject({ total: 1, success: 0, failed: 0, skipped: 1 });
    // Post-level totals stay post-level.
    expect(summary).toMatchObject({ totalPosts: 1, published: 1, successRate: 100 });
  });

  test('legacy plain-string channels keep the parent-status treatment', async () => {
    mockPosts = [
      { id: 2, status: 'draft', created_at: new Date().toISOString(), platforms_posted: JSON.stringify(['facebook', 'gbp']) },
      { id: 3, status: 'scheduled', created_at: new Date().toISOString(), platforms_posted: ['facebook'] },
      { id: 4, status: 'published', created_at: new Date().toISOString(), platforms_posted: JSON.stringify(['gbp']) },
    ];
    const res = await call('GET', '/api/admin/social-media/analytics');
    const { byPlatform } = res.body;
    expect(byPlatform.facebook).toMatchObject({ total: 2, draft: 1, scheduled: 1, success: 0, skipped: 0 });
    expect(byPlatform.gbp).toMatchObject({ total: 2, draft: 1, success: 1, skipped: 0 });
  });
});
