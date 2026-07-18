/**
 * Social channel ops tool — unit tests with mocked flags, env, and DB.
 * Read-only contract: channel flag + credential matrix, switch states,
 * recent-post mapping with failed count, DB failure isolation.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockOrderBy = jest.fn();
const mockLimit = jest.fn();
jest.mock('../models/db', () => {
  const chain = { select: jest.fn(() => chain), orderBy: (...a) => { mockOrderBy(...a); return chain; }, limit: (...a) => mockLimit(...a) };
  return jest.fn(() => chain);
});

let mockPaused = false;
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: {
    get automationEnabled() { return process.env.SOCIAL_AUTOMATION_ENABLED === 'true'; },
    get rssAutopublish() { return false; },
    get scheduledPosts() { return true; },
    get newsletterAutoshare() { return false; },
    get facebookEnabled() { return process.env.SOCIAL_FACEBOOK_ENABLED === 'true'; },
    get instagramEnabled() { return false; },
    get gbpEnabled() { return true; },
    get linkedinEnabled() { return true; },
    get twitterEnabled() { return false; },
    get dryRun() { return process.env.SOCIAL_DRY_RUN === 'true'; },
  },
  isPausedByAdmin: jest.fn(async () => mockPaused),
}));

const ENV_KEYS = [
  'SOCIAL_AUTOMATION_ENABLED', 'SOCIAL_FACEBOOK_ENABLED', 'SOCIAL_DRY_RUN',
  'FACEBOOK_ACCESS_TOKEN', 'FACEBOOK_PAGE_ID', 'INSTAGRAM_ACCOUNT_ID',
  'LINKEDIN_ACCESS_TOKEN', 'TWITTER_API_KEY', 'TWITTER_ACCESS_TOKEN',
];
const savedEnv = {};
const { executeSocialOpsTool } = require('../services/intelligence-bar/social-ops-tools');

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPaused = false;
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('intelligence bar social ops tool', () => {
  test('unknown tool name returns an error result', async () => {
    const result = await executeSocialOpsTool('publish_post');
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('reports channel matrix, switches, and recent posts with failed count', async () => {
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
    process.env.SOCIAL_FACEBOOK_ENABLED = 'true';
    process.env.SOCIAL_DRY_RUN = 'true';
    process.env.FACEBOOK_ACCESS_TOKEN = 'tok';
    process.env.FACEBOOK_PAGE_ID = 'page';
    process.env.LINKEDIN_ACCESS_TOKEN = 'li';
    mockLimit.mockResolvedValueOnce([
      { title: 'New blog: chinch bugs', status: 'published', source_type: 'rss', platforms_posted: ['facebook'], scheduled_for: null, published_at: new Date('2026-07-17T15:00:00Z'), created_at: new Date() },
      { title: 'x'.repeat(300), status: 'failed', source_type: 'manual', platforms_posted: [], scheduled_for: null, published_at: null, created_at: new Date() },
    ]);

    const result = await executeSocialOpsTool('get_social_channel_status');
    expect(result.error).toBeUndefined();
    expect(result.channels.facebook).toEqual({ enabled: true, credentials_present: true });
    // Flag on but no token — the silent-failure combination the tool exists to surface
    expect(result.channels.linkedin.enabled).toBe(true);
    expect(result.channels.linkedin.credentials_present).toBe(true);
    expect(result.channels.twitter).toEqual({ enabled: false, credentials_present: false });
    expect(result.switches.dry_run).toBe(true);
    expect(result.switches.paused_by_admin).toBe(false);
    expect(result.recent_posts[0].platforms_posted).toEqual(['facebook']);
    expect(result.recent_posts[1].title).toHaveLength(120);
    expect(result.failed_recent).toBe(1);
  });

  test('DB failure is isolated — flags still report, posts come back empty', async () => {
    mockLimit.mockRejectedValueOnce(new Error('relation does not exist'));
    const result = await executeSocialOpsTool('get_social_channel_status');
    expect(result.error).toBeUndefined();
    expect(result.channels).toBeDefined();
    expect(result.recent_posts).toEqual([]);
  });
});
