/**
 * Codex r10 on #5216 ("Recheck related-post liveness before auto-merge"):
 * getLiveRelatedPaths only ran while deriving the pre-publish guard options
 * (_deriveGuardrailOptions) — the poller's merge-time checks (topics,
 * competitors, evidence, images) never rechecked frontmatter related_posts
 * against the live corpus, so a related post unpublished/noindexed/moved
 * between PR-open and merge could still ship a stale rail. These tests
 * cover relatedPostsLivenessVerdict directly — the same unit-level style
 * autonomous-pr-poller.test.js already uses for affiliateBeltVerdict.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content/related-posts', () => ({
  getLiveRelatedPaths: jest.fn(),
  _internals: { normalizePathForCompare: jest.requireActual('../services/content/related-posts')._internals.normalizePathForCompare },
}));

const relatedPosts = require('../services/content/related-posts');
const poller = require('../services/content/autonomous-pr-poller');
const { relatedPostsLivenessVerdict } = poller._internals;

function fileWith(frontmatterYaml) {
  return `---\n${frontmatterYaml}\n---\n\nBody.\n`;
}

afterEach(() => jest.clearAllMocks());

describe('relatedPostsLivenessVerdict', () => {
  test('no frontmatter.related_posts at all → ok, no live-corpus read', async () => {
    const res = await relatedPostsLivenessVerdict(fileWith('title: Test Post\nslug: /pest-control/test-post/'));
    expect(res).toEqual({ ok: true });
    expect(relatedPosts.getLiveRelatedPaths).not.toHaveBeenCalled();
  });

  test('every frontmatter related_posts path still live → ok, proceeds', async () => {
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set(['/pest-control/fire-ants/', '/pest-control/carpenter-ants/']));
    const res = await relatedPostsLivenessVerdict(fileWith(
      'title: Test Post\nslug: /pest-control/test-post/\ndomains: ["wavespestcontrol.com"]\nrelated_posts:\n  - /pest-control/fire-ants/\n  - /pest-control/carpenter-ants/',
    ));
    expect(res).toEqual({ ok: true });
    expect(relatedPosts.getLiveRelatedPaths).toHaveBeenCalledWith(
      ['/pest-control/fire-ants/', '/pest-control/carpenter-ants/'],
      { hosts: ['wavespestcontrol.com'] },
    );
  });

  test('a related_posts path no longer live → withheld, names the stale path', async () => {
    // fire-ants unpublished/moved since the brief verified it; carpenter-ants still live.
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set(['/pest-control/carpenter-ants/']));
    const res = await relatedPostsLivenessVerdict(fileWith(
      'title: Test Post\nslug: /pest-control/test-post/\nrelated_posts:\n  - /pest-control/fire-ants/\n  - /pest-control/carpenter-ants/',
    ));
    expect(res.ok).toBe(false);
    expect(res.transient).not.toBe(true);
    expect(res.reason).toMatch(/\/pest-control\/fire-ants\//);
    expect(res.reason).not.toMatch(/\/pest-control\/carpenter-ants\//);
  });

  test('the live-corpus read failing → withheld, transient (fail closed)', async () => {
    relatedPosts.getLiveRelatedPaths.mockRejectedValue(new Error('db unavailable'));
    const res = await relatedPostsLivenessVerdict(fileWith(
      'title: Test Post\nslug: /pest-control/test-post/\nrelated_posts:\n  - /pest-control/fire-ants/',
    ));
    expect(res).toMatchObject({ ok: false, transient: true, reason: expect.stringMatching(/db unavailable/) });
  });

  test('the head file itself being unreadable (null/undefined content) → withheld, transient', async () => {
    expect(await relatedPostsLivenessVerdict(null)).toMatchObject({ ok: false, transient: true });
    expect(await relatedPostsLivenessVerdict(undefined)).toMatchObject({ ok: false, transient: true });
    expect(relatedPosts.getLiveRelatedPaths).not.toHaveBeenCalled();
  });

  test('accepts the refresh lane\'s { content } shape, not just a bare string', async () => {
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set(['/pest-control/fire-ants/']));
    const res = await relatedPostsLivenessVerdict({ content: fileWith('title: X\nrelated_posts:\n  - /pest-control/fire-ants/') });
    expect(res).toEqual({ ok: true });
  });

  test('a malformed/invalid related_posts entry is filtered out rather than crashing the recheck', async () => {
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set(['/pest-control/fire-ants/']));
    const res = await relatedPostsLivenessVerdict(fileWith(
      'title: X\nrelated_posts:\n  - /pest-control/fire-ants/\n  - ""',
    ));
    expect(res).toEqual({ ok: true });
    expect(relatedPosts.getLiveRelatedPaths).toHaveBeenCalledWith(['/pest-control/fire-ants/'], {});
  });
});
