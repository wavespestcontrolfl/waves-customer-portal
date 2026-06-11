/**
 * sweepRecentlyPublished — the daily visibility-backstop cron entrypoint.
 * Re-checks blogs that recently went live AND autonomous_runs publishes
 * (which have no blog_posts row); bounded batch, never throws.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/seo/sitemap-manager', () => ({}));
jest.mock('../services/seo/indexnow-submit', () => ({}));
jest.mock('../services/content/ai-visibility-gate', () => ({ evaluate: jest.fn(), _internals: {} }));

let mockState;

jest.mock('../models/db', () => {
  const dbFn = jest.fn((table) => {
    const q = {
      where: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      limit: jest.fn((n) => { mockState.limits[table] = n; return q; }),
      select: jest.fn(() => (mockState.rejects[table]
        ? Promise.reject(new Error(`query failed: ${table}`))
        : Promise.resolve(mockState.rows[table] || []))),
    };
    return q;
  });
  return dbFn;
});

const logger = require('../services/logger');
const worker = require('../services/content/post-publish-visibility-worker');

beforeEach(() => {
  mockState = { rows: {}, rejects: {}, limits: {} };
  jest.clearAllMocks();
});

describe('sweepRecentlyPublished', () => {
  test('checks recent live blog_posts and autonomous_runs publishes, bounded', async () => {
    mockState.rows.blog_posts = [
      { id: 1, slug: 'a', title: 'A', keyword: 'k', astro_live_url: 'https://www.wavespestcontrol.com/blog/a/' },
    ];
    mockState.rows.autonomous_runs = [
      { id: 'run-1', published_url: 'https://www.wavespestcontrol.com/blog/auto/' },
    ];
    const runPost = jest.fn().mockResolvedValue({ ok: true });
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl, limit: 5 });

    expect(runPost).toHaveBeenCalledTimes(1);
    expect(runPost).toHaveBeenCalledWith(mockState.rows.blog_posts[0]);
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(runUrl).toHaveBeenCalledWith('https://www.wavespestcontrol.com/blog/auto/');
    expect(res.checked).toBe(2);
    expect(mockState.limits.blog_posts).toBe(5);
    expect(mockState.limits.autonomous_runs).toBe(5);
  });

  test('one failing check logs and never aborts the rest of the sweep', async () => {
    mockState.rows.blog_posts = [
      { id: 1, astro_live_url: 'https://x/1/' },
      { id: 2, astro_live_url: 'https://x/2/' },
    ];
    mockState.rows.autonomous_runs = [{ id: 'run-1', published_url: 'https://x/3/' }];
    const runPost = jest.fn()
      .mockRejectedValueOnce(new Error('fetch blew up'))
      .mockResolvedValue({ ok: true });
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl });

    expect(runPost).toHaveBeenCalledTimes(2);
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(3);
    expect(res.results[0].error).toMatch(/fetch blew up/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fetch blew up'));
  });

  test('a query failure logs and resolves instead of throwing out of the cron', async () => {
    mockState.rejects.blog_posts = true;
    mockState.rows.autonomous_runs = [{ id: 'run-1', published_url: 'https://x/3/' }];
    const runPost = jest.fn();
    const runUrl = jest.fn().mockResolvedValue({ ok: true });

    const res = await worker.sweepRecentlyPublished({ runPost, runUrl });

    expect(runPost).not.toHaveBeenCalled();
    expect(runUrl).toHaveBeenCalledTimes(1);
    expect(res.checked).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('query failed: blog_posts'));
  });
});
