/**
 * Live-flip auto-share (owner directive 2026-07-16, explicitly confirmed):
 * a MANUAL-lane post shares to social the moment pollLivePost verifies it
 * live. The scheduler lane (publish_status='publishing') is excluded — it
 * invokes sharePublishedBlog itself after observing live — and a share
 * failure must never block the live flip.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-scheduler', () => ({ sharePublishedBlog: jest.fn() }));

const db = require('../models/db');
const scheduler = require('../services/content-scheduler');
const pagesPoll = require('../services/content-astro/pages-poll');

const NOW = Date.now();

function setupDb() {
  const updates = [];
  db.mockImplementation((table) => ({
    where: jest.fn(function () { return this; }),
    update: jest.fn((u) => { updates.push({ table, updates: u }); return Promise.resolve(1); }),
  }));
  return updates;
}

function mockFetch() {
  global.fetch = jest.fn(async (url, opts = {}) => {
    if (String(url).includes('api.cloudflare.com')) {
      return {
        ok: true,
        json: async () => ({
          result: [{
            id: 'dep-1',
            environment: 'production',
            created_on: new Date(NOW).toISOString(),
            url: 'https://deploy.example',
            latest_stage: { name: 'deploy', status: 'success' },
          }],
        }),
      };
    }
    // live-URL check (HEAD)
    return { ok: true, status: 200 };
  });
}

function makePost(overrides = {}) {
  return {
    id: 'post-1',
    slug: 'pest-control/test-post',
    title: 'Test Post',
    astro_status: 'merged',
    astro_merged_at: new Date(NOW - 60000).toISOString(),
    astro_live_url: 'https://www.wavespestcontrol.com/pest-control/test-post/',
    publish_status: null,
    auto_share_social: true,
    shared_to_social: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CF_API_TOKEN = 't';
  process.env.CF_ACCOUNT_ID = 'a';
  delete process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED;
  mockFetch();
  // visibility worker is lazy-required and fail-soft; make it a no-op
  jest.mock('../services/content/post-publish-visibility-worker', () => ({ runForPost: jest.fn() }), { virtual: false });
});

afterEach(() => {
  delete process.env.CF_API_TOKEN;
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED;
});

describe('pollLivePost live-flip auto-share', () => {
  test('manual-lane post shares once verified live (post handed over WITH live url + updates)', async () => {
    const updates = setupDb();
    const r = await pagesPoll.pollLivePost(makePost());
    expect(r.live).toBe(true);
    expect(updates.find((u) => u.updates.astro_status === 'live')).toBeDefined();
    expect(scheduler.sharePublishedBlog).toHaveBeenCalledTimes(1);
    const arg = scheduler.sharePublishedBlog.mock.calls[0][0];
    expect(arg.astro_live_url).toContain('/pest-control/test-post/');
    expect(arg.astro_status).toBe('live');
  });

  test('scheduler-claimed rows are excluded (that lane shares itself)', async () => {
    setupDb();
    const r = await pagesPoll.pollLivePost(makePost({ publish_status: 'publishing' }));
    expect(r.live).toBe(true);
    expect(scheduler.sharePublishedBlog).not.toHaveBeenCalled();
  });

  test('kill switch SOCIAL_BLOG_LIVE_SHARE_ENABLED=false disables the share, not the flip', async () => {
    setupDb();
    process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED = 'false';
    const r = await pagesPoll.pollLivePost(makePost());
    expect(r.live).toBe(true);
    expect(scheduler.sharePublishedBlog).not.toHaveBeenCalled();
  });

  test('a share failure never blocks the live flip (fail-soft)', async () => {
    const updates = setupDb();
    scheduler.sharePublishedBlog.mockRejectedValue(new Error('meta 500'));
    const r = await pagesPoll.pollLivePost(makePost());
    expect(r.live).toBe(true);
    expect(updates.find((u) => u.updates.astro_status === 'live')).toBeDefined();
  });
});
