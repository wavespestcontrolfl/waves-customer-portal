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

// Codex r2 on #5272 ("Recheck every related-post link surface"): a
// brief-frozen related path linked from the body or a next_steps button is
// rechecked too, not only the rail.
describe('relatedPostsLivenessVerdict — every surface', () => {
  const frozen = { paths: ['/pest-control/fire-ants/', '/pest-control/ghost-ants/'] };
  const file = (fmExtra, body) => `---\ntitle: T\nslug: /pest-control/t/\ndomains: ["wavespestcontrol.com"]\n${fmExtra}---\n\n${body}\n`;
  test('a frozen related post linked only in the body and no longer live withholds', async () => {
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set());
    const res = await relatedPostsLivenessVerdict(file('', 'See [fire ants](/pest-control/fire-ants/) too.'), frozen);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('/pest-control/fire-ants/');
  });
  test('a frozen related post used as a next_steps href is rechecked', async () => {
    relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set(['/pest-control/ghost-ants/']));
    const res = await relatedPostsLivenessVerdict(file('next_steps:\n  - label: Ghost ants?\n    href: /pest-control/ghost-ants/\n', 'Body.'), frozen);
    expect(res).toEqual({ ok: true });
    expect(relatedPosts.getLiveRelatedPaths).toHaveBeenCalledWith(['/pest-control/ghost-ants/'], { hosts: ['wavespestcontrol.com'] });
  });
  test('a body link that is not a frozen related post is not rechecked', async () => {
    const res = await relatedPostsLivenessVerdict(file('', 'See [our services](/pest-control-services/).'), frozen);
    expect(res).toEqual({ ok: true });
    expect(relatedPosts.getLiveRelatedPaths).not.toHaveBeenCalled();
  });
  test('an unavailable brief lookup withholds (transient)', async () => {
    const res = await relatedPostsLivenessVerdict(file('', 'Body.'), { unavailable: true });
    expect(res).toMatchObject({ ok: false, transient: true });
  });
});

// Codex r4 on #5272 ("Recheck multiline reference-style related links").
test('a frozen related post linked through a multi-line reference definition is rechecked', async () => {
  relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set());
  const file = '---\ntitle: T\nslug: /pest-control/t/\ndomains: ["wavespestcontrol.com"]\n---\n\nSee [ants][fire].\n\n[fire]:\n  /pest-control/fire-ants/\n';
  const res = await relatedPostsLivenessVerdict(file, { paths: ['/pest-control/fire-ants/'] });
  expect(res.ok).toBe(false);
  expect(res.reason).toContain('/pest-control/fire-ants/');
});

// Codex r6 on #5272 ("Preserve container depths when resolving reference links").
test('a related link whose definition starts in a blockquote is rechecked', async () => {
  relatedPosts.getLiveRelatedPaths.mockResolvedValue(new Set());
  const file = '---\ntitle: T\nslug: /pest-control/t/\ndomains: ["wavespestcontrol.com"]\n---\n\nSee [ants][fire].\n> [fire]:\n> /pest-control/fire-ants/\n';
  const res = await relatedPostsLivenessVerdict(file, { paths: ['/pest-control/fire-ants/'] });
  expect(res.ok).toBe(false);
});

// Codex r9 on #5272 ("Ignore unused reference definitions during liveness checks").
test('an unused reference definition is not a rendered link', async () => {
  const file = '---\ntitle: T\nslug: /pest-control/t/\ndomains: ["wavespestcontrol.com"]\n---\n\nBody with no link.\n\n[fire]: /pest-control/fire-ants/\n';
  const res = await relatedPostsLivenessVerdict(file, { paths: ['/pest-control/fire-ants/'] });
  expect(res).toEqual({ ok: true });
  expect(relatedPosts.getLiveRelatedPaths).not.toHaveBeenCalled();
});

