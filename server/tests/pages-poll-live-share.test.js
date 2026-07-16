/**
 * Live-flip auto-share (owner directive 2026-07-16, explicitly confirmed):
 * a MANUAL-lane post shares to social the moment pollLivePost verifies it
 * live, via shareUrlOnce (advisory-lock + source_url dedupe — atomic against
 * the RSS backstop and concurrent refresh/cron ticks). The scheduler lane
 * (publish_status='publishing') is excluded — it shares itself after
 * observing live. The row is re-fetched because pollPending's projection
 * omits the share fields, and a share failure never blocks the live flip.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: { automationEnabled: true, rssAutopublish: true },
  isPausedByAdmin: jest.fn().mockResolvedValue(false),
  shareUrlOnce: jest.fn().mockResolvedValue({ shared: true, success: true }),
}));

const db = require('../models/db');
const social = require('../services/social-media');
const pagesPoll = require('../services/content-astro/pages-poll');

const NOW = Date.now();

let freshRow;

function setupDb() {
  const updates = [];
  db.mockImplementation((table) => ({
    where: jest.fn(function () { return this; }),
    first: jest.fn(() => Promise.resolve(freshRow)),
    update: jest.fn((u) => { updates.push({ table, updates: u }); return Promise.resolve(1); }),
  }));
  return updates;
}

function mockFetch() {
  global.fetch = jest.fn(async (url) => {
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
    return { ok: true, status: 200 };
  });
}

function makePost(overrides = {}) {
  return {
    id: 'post-1',
    slug: 'pest-control/test-post',
    astro_status: 'merged',
    astro_merged_at: new Date(NOW - 60000).toISOString(),
    astro_live_url: 'https://www.wavespestcontrol.com/pest-control/test-post/',
    publish_status: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  social.SOCIAL_FLAGS.automationEnabled = true;
  social.SOCIAL_FLAGS.rssAutopublish = true;
  social.isPausedByAdmin.mockResolvedValue(false);
  social.shareUrlOnce.mockResolvedValue({ shared: true, success: true });
  process.env.CF_API_TOKEN = 't';
  process.env.CF_ACCOUNT_ID = 'a';
  delete process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED;
  mockFetch();
  // Full row as production stores it — the POLL projection omits these.
  freshRow = {
    id: 'post-1',
    title: 'Test Post',
    meta_description: 'Meta',
    auto_share_social: true,
    shared_to_social: false,
  };
});

afterEach(() => {
  delete process.env.CF_API_TOKEN;
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED;
});

describe('pollLivePost live-flip auto-share', () => {
  test('manual-lane post shares via shareUrlOnce with the RE-FETCHED row fields and stamps shared_to_social', async () => {
    const updates = setupDb();
    const r = await pagesPoll.pollLivePost(makePost());
    await r._sharePromise;
    expect(r.live).toBe(true);
    expect(social.shareUrlOnce).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Post',
      description: 'Meta',
      link: expect.stringContaining('/pest-control/test-post/'),
      source: 'blog',
      noAiImage: true,
    }));
    expect(updates.find((u) => u.updates.shared_to_social === true)).toBeDefined();
  });

  test('per-post opt-out and already-shared rows do not share', async () => {
    setupDb();
    freshRow.auto_share_social = false;
    await (await pagesPoll.pollLivePost(makePost()))._sharePromise;
    expect(social.shareUrlOnce).not.toHaveBeenCalled();

    freshRow = { ...freshRow, auto_share_social: true, shared_to_social: true };
    await (await pagesPoll.pollLivePost(makePost()))._sharePromise;
    expect(social.shareUrlOnce).not.toHaveBeenCalled();
  });

  test('scheduler-claimed rows, kill switch, automation-off, and admin pause all skip the share (flip unaffected)', async () => {
    setupDb();
    const poll = async (over) => { const r = await pagesPoll.pollLivePost(makePost(over)); await r._sharePromise; return r; };
    expect((await poll({ publish_status: 'publishing' })).live).toBe(true);
    expect(social.shareUrlOnce).not.toHaveBeenCalled();

    process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED = 'false';
    expect((await poll()).live).toBe(true);
    expect(social.shareUrlOnce).not.toHaveBeenCalled();
    delete process.env.SOCIAL_BLOG_LIVE_SHARE_ENABLED;

    social.SOCIAL_FLAGS.automationEnabled = false;
    expect((await poll()).live).toBe(true);
    expect(social.shareUrlOnce).not.toHaveBeenCalled();
    social.SOCIAL_FLAGS.automationEnabled = true;

    social.SOCIAL_FLAGS.rssAutopublish = false;
    expect((await poll()).live).toBe(true);
    expect(social.shareUrlOnce).not.toHaveBeenCalled();
    social.SOCIAL_FLAGS.rssAutopublish = true;

    social.isPausedByAdmin.mockResolvedValue(true);
    expect((await poll()).live).toBe(true);
    expect(social.shareUrlOnce).not.toHaveBeenCalled();
  });

  test('stamping: already_posted stamps, other skips/dry-run do not; a throw never blocks the flip', async () => {
    const poll = async () => { const r = await pagesPoll.pollLivePost(makePost()); await r._sharePromise; return r; };
    // already_posted with a PUBLISHED/SCHEDULED blocker = definitively out —
    // STAMP it so the scheduler path can't double-post later.
    let updates = setupDb();
    social.shareUrlOnce.mockResolvedValue({ skipped: 'already_posted', blocking_status: 'published' });
    expect((await poll()).live).toBe(true);
    expect(updates.find((u) => u.updates.shared_to_social === true)).toBeDefined();

    // already_posted with a DRAFT blocker = studio copy exists but nothing
    // posted — must NOT stamp (the admin publishing/rejecting the draft is
    // the recovery path).
    updates = setupDb();
    social.shareUrlOnce.mockResolvedValue({ skipped: 'already_posted', blocking_status: 'draft' });
    expect((await poll()).live).toBe(true);
    expect(updates.find((u) => u.updates.shared_to_social === true)).toBeUndefined();

    updates = setupDb();
    social.shareUrlOnce.mockResolvedValue({ skipped: 'automation_disabled' });
    expect((await poll()).live).toBe(true);
    expect(updates.find((u) => u.updates.shared_to_social === true)).toBeUndefined();

    updates = setupDb();
    social.shareUrlOnce.mockResolvedValue({ shared: true, success: true, dryRun: true });
    expect((await poll()).live).toBe(true);
    expect(updates.find((u) => u.updates.shared_to_social === true)).toBeUndefined();

    updates = setupDb();
    social.shareUrlOnce.mockRejectedValue(new Error('meta 500'));
    const r = await pagesPoll.pollLivePost(makePost());
    await r._sharePromise;
    expect(r.live).toBe(true);
    expect(updates.find((u) => u.updates.astro_status === 'live')).toBeDefined();
  });
});
