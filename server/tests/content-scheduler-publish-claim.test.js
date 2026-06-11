/**
 * content-scheduler crash-window hardening:
 *   - the 'publishing' claim is an atomic compare-and-set (0 rows updated
 *     → another instance owns the blog → skip it, never double-publish),
 *   - rows stranded at publish_status='publishing' (process died
 *     mid-publish) are swept back to 'pending_review' after ~30 min, which
 *     also disarms pages-poll's pr_open+publishing auto-merge branch.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: { automationEnabled: false, scheduledPosts: false, newsletterAutoshare: false },
  isPausedByAdmin: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/content-astro/astro-publisher', () => ({
  publishAstro: jest.fn(),
}));

let mockState;

jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const q = {
      _table: table,
      _filters: [],
      where: jest.fn(function (...args) {
        if (typeof args[0] === 'function') args[0].call(q);
        else q._filters.push(args);
        return q;
      }),
      orWhere: jest.fn(function (...args) {
        if (typeof args[0] === 'function') args[0].call(q);
        return q;
      }),
      whereNull: jest.fn(() => q),
      orWhereNull: jest.fn(() => q),
      whereIn: jest.fn(() => q),
      whereNotIn: jest.fn(() => q),
      orWhereNotIn: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn(() => Promise.resolve([])),
      update: jest.fn((updates) => {
        mockState.updates.push({ table, filters: q._filters.slice(), updates });
        return Promise.resolve(mockState.updateResult(table, q._filters, updates));
      }),
      // The pending-blogs query is awaited directly (no .select()), so the
      // builder itself must be thenable.
      then: (resolve, reject) => Promise.resolve(mockState.pendingBlogs).then(resolve, reject),
    };
    return q;
  });
  return dbFn;
});

const ContentScheduler = require('../services/content-scheduler');
const AstroPublisher = require('../services/content-astro/astro-publisher');

function isClaimUpdate(u) {
  return u.table === 'blog_posts' && u.updates.publish_status === 'publishing';
}

function isStaleSweepUpdate(u) {
  return u.table === 'blog_posts'
    && u.updates.publish_status === 'pending_review'
    && u.filters.some(([col, val]) => col === 'publish_status' && val === 'publishing');
}

beforeEach(() => {
  mockState = {
    pendingBlogs: [],
    updates: [],
    updateResult: () => 1,
  };
  jest.clearAllMocks();
});

describe('stale-publishing sweep', () => {
  test('resets rows stranded in publishing for >30 min back to pending_review', async () => {
    mockState.updateResult = () => 2;
    const reset = await ContentScheduler.resetStalePublishingBlogs();

    expect(reset).toBe(2);
    const sweep = mockState.updates[0];
    expect(sweep.table).toBe('blog_posts');
    expect(sweep.updates.publish_status).toBe('pending_review');
    // guarded to stranded rows only: publishing + updated_at older than cutoff
    expect(sweep.filters).toEqual(expect.arrayContaining([
      ['publish_status', 'publishing'],
      ['updated_at', '<', expect.any(Date)],
    ]));
    const cutoff = sweep.filters.find(([col]) => col === 'updated_at')[2];
    const ageMinutes = (Date.now() - cutoff.getTime()) / 60000;
    expect(ageMinutes).toBeGreaterThanOrEqual(29);
    expect(ageMinutes).toBeLessThanOrEqual(31);
  });

  test('processScheduledPosts runs the sweep every tick', async () => {
    await ContentScheduler.processScheduledPosts();
    expect(mockState.updates.some(isStaleSweepUpdate)).toBe(true);
  });
});

describe('atomic publishing claim', () => {
  const blog = {
    id: 7,
    title: 'Scheduled Post',
    content: '# body',
    publish_status: 'pending',
    astro_status: null,
  };

  test('claims with a compare-and-set guarded on the selected publish_status', async () => {
    mockState.pendingBlogs = [blog];
    await ContentScheduler.processScheduledPosts();

    const claim = mockState.updates.find(isClaimUpdate);
    expect(claim).toBeDefined();
    expect(claim.filters).toEqual(expect.arrayContaining([
      ['id', 7],
      ['publish_status', 'pending'],
    ]));
    expect(claim.updates.updated_at).toBeInstanceOf(Date);
    expect(AstroPublisher.publishAstro).toHaveBeenCalledWith(7);
  });

  test('skips the blog when another instance claimed it first (0 rows updated)', async () => {
    mockState.pendingBlogs = [blog];
    mockState.updateResult = (table, filters, updates) =>
      (updates.publish_status === 'publishing' ? 0 : 1);

    const result = await ContentScheduler.processScheduledPosts();

    expect(AstroPublisher.publishAstro).not.toHaveBeenCalled();
    expect(result.blogCount).toBe(0);
    expect(result.errors).toBe(0);
    // and the skip must NOT stomp the other instance's claim back to
    // pending_review — the only pending_review write allowed is the sweep's
    const stomps = mockState.updates.filter((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending_review'
      && u.filters.some(([col, val]) => col === 'id' && val === 7));
    expect(stomps).toHaveLength(0);
  });

  test('publish failure after a successful claim releases the row to pending_review', async () => {
    mockState.pendingBlogs = [blog];
    AstroPublisher.publishAstro.mockRejectedValue(new Error('GitHub down'));

    const result = await ContentScheduler.processScheduledPosts();

    expect(result.errors).toBe(1);
    const release = mockState.updates.find((u) =>
      u.table === 'blog_posts'
      && u.updates.publish_status === 'pending_review'
      && u.filters.some(([col, val]) => col === 'id' && val === 7));
    expect(release).toBeDefined();
  });
});
