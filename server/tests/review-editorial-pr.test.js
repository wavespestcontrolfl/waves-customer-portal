jest.mock('../services/content/codex-remediation', () => ({ validateFixedBlogFile: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  env: jest.fn(() => ({ owner: 'waves', repo: 'astro', defaultBranch: 'main' })),
  getPr: jest.fn(), ghFetchPaginated: jest.fn(), getFile: jest.fn(), commitFiles: jest.fn(),
}));
jest.mock('../services/content/editorial-evidence', () => ({
  enabled: () => true, applicable: (path) => path.startsWith('src/content/blog/'),
  filesForDocument: jest.fn(), prepareDraft: jest.fn(),
  evidenceDomain: jest.fn(),
}));
jest.mock('../../packages/editorial-evidence/index.cjs', () => ({
  evidencePath: (path) => `${path}.json`, verifyManifest: jest.fn(),
}));
const gh = require('../services/content-astro/github-client');
const editorial = require('../services/content/editorial-evidence');
const contract = require('../../packages/editorial-evidence/index.cjs');
const validateFixedBlogFile = require('../services/content/codex-remediation').validateFixedBlogFile;
const { reviewPr, retryReview, refreshStale } = require('../scripts/review-editorial-pr');
const path = 'src/content/blog/test.md';
const pr = { number: 1, state: 'open', head: { sha: 'reviewed-sha', ref: 'content/test', repo: { full_name: 'waves/astro' } }, base: { ref: 'main', sha: 'base-sha' } };
beforeEach(() => {
  jest.clearAllMocks();
  validateFixedBlogFile.mockReset().mockResolvedValue({ ok: true, requiresHumanReview: false });
  gh.getPr.mockResolvedValue(pr);
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'modified' }]);
  gh.getFile.mockImplementation(async (name) => ({ content: name.endsWith('.json') ? '{}' : '---\ntitle: Test\n---\nTest body' }));
  contract.verifyManifest.mockReturnValue({ pass: false });
  editorial.evidenceDomain.mockReturnValue('wavespestcontrol.com');
  editorial.filesForDocument.mockResolvedValue([{ path: `${path}.json`, content: '{}' }]);
  gh.commitFiles.mockResolvedValue({ commit: { sha: 'evidence-sha' } });
});
test('only trusted same-repository PRs may receive evidence', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } });
  await expect(reviewPr(1)).rejects.toThrow('same-repository');
  expect(editorial.filesForDocument).not.toHaveBeenCalled();
});
test('pins evidence commit to reviewed head, validates managed bytes, and never repairs them', async () => {
  expect(await reviewPr(1)).toMatchObject({ pass: true, requiresFreshBuild: true });
  expect(gh.commitFiles).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: 'reviewed-sha' }));
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
  expect(validateFixedBlogFile).toHaveBeenCalledWith(expect.any(String), {
    originalMetaDescription: '',
    requireFactCheck: true,
  });
  expect(gh.getFile).toHaveBeenCalledWith(path, 'base-sha');
});
test('freshly signed managed bytes need no repeat validation or base read', async () => {
  contract.verifyManifest.mockReturnValue({ pass: true });
  await expect(reviewPr(1)).resolves.toEqual({ pass: true, unchanged: true });
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
  expect(validateFixedBlogFile).not.toHaveBeenCalled();
  expect(gh.getFile).not.toHaveBeenCalledWith(path, 'base-sha');
  expect(gh.commitFiles).not.toHaveBeenCalled();
});
test('expired authenticated exact bytes skip legacy gates but receive a new independent review and signature', async () => {
  contract.verifyManifest.mockImplementation(({ requireFresh }) => ({ pass: requireFresh === false }));

  expect(await reviewPr(1)).toMatchObject({ pass: true, requiresFreshBuild: true });
  expect(contract.verifyManifest).toHaveBeenCalledWith(expect.objectContaining({ requireFresh: false }));
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
  expect(validateFixedBlogFile).not.toHaveBeenCalled();
  expect(gh.getFile).not.toHaveBeenCalledWith(path, 'base-sha');
  expect(editorial.filesForDocument).toHaveBeenCalledWith(expect.objectContaining({
    document: expect.stringContaining('Test body'),
    path,
  }));
  expect(gh.commitFiles).toHaveBeenCalledTimes(1);
});
test('an invalid or unsigned sidecar on content/foo cannot waive publishing policy', async () => {
  validateFixedBlogFile.mockResolvedValue({ ok: false, requiresHumanReview: false, reason: 'guardrails BLOG_META_SALESY' });

  await expect(reviewPr(1)).resolves.toEqual(expect.objectContaining({
    pass: false,
    deferred: true,
    failures: [expect.objectContaining({ reason: expect.stringContaining('BLOG_META_SALESY') })],
  }));
  expect(contract.verifyManifest).toHaveBeenCalledWith(expect.objectContaining({ requireFresh: false }));
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
  expect(editorial.filesForDocument).not.toHaveBeenCalled();
  expect(gh.commitFiles).not.toHaveBeenCalled();
});
test('head movement prevents any evidence commit', async () => {
  gh.getPr.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, head: { ...pr.head, sha: 'new-sha' } });
  await expect(reviewPr(1)).rejects.toThrow('changed during review');
  expect(gh.commitFiles).not.toHaveBeenCalled();
});
test('base movement prevents evidence committed from an obsolete metadata grandfather', async () => {
  gh.getPr.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, base: { ...pr.base, sha: 'new-base-sha' } });
  await expect(reviewPr(1)).rejects.toThrow('changed during review');
  expect(gh.commitFiles).not.toHaveBeenCalled();
});
test('automatic retry recovers outages and has a hard attempt budget', async () => {
  const review = jest.fn().mockRejectedValue(new Error('outage'));
  const wait = jest.fn().mockResolvedValue();
  expect(await retryReview(1, { review, wait })).toMatchObject({ pass: false, deferred: true, attempts: 3, exhausted: true });
  expect(review).toHaveBeenCalledTimes(3);
  review.mockReset().mockResolvedValueOnce({ pass: false }).mockResolvedValueOnce({ pass: true });
  expect(await retryReview(1, { review, wait })).toEqual({ pass: true });
  expect(review).toHaveBeenCalledTimes(2);
});
test('scheduled expiry refresh rotates work so a fixed prefix cannot monopolize batches', async () => {
  const prs = Array.from({ length: 6 }, (_, i) => ({ ...pr, number: i + 1 }));
  gh.ghFetchPaginated.mockImplementation(async (url) => url.includes('?state=open') ? prs : [{ filename: path, status: 'modified' }]);
  gh.getPr.mockImplementation(async (number) => prs[number - 1]);
  contract.verifyManifest.mockImplementation(({ requireFresh }) => ({ pass: requireFresh === false }));
  const first = await refreshStale({ now: 0 });
  const second = await refreshStale({ now: 1800000 });
  expect(first.results.map((item) => item.pr)).toEqual([1, 2, 3]);
  expect(second.results.map((item) => item.pr)).toEqual([4, 5, 6]);
});

test('hand-authored repairs cannot waive policies that require human review', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, ref: 'article/test' } });
  editorial.prepareDraft.mockResolvedValue({ body: 'Test body' });
  const validate = require('../services/content/codex-remediation').validateFixedBlogFile;
  validate.mockResolvedValue({ ok: true, requiresHumanReview: true });
  expect(await reviewPr(1)).toMatchObject({ pass: false, deferred: true });
  expect(validate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ requireFactCheck: true }));
  expect(gh.commitFiles).not.toHaveBeenCalled();
});

test('hand-authored metadata changes are validated against the exact immutable base value', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, ref: 'article/test' } });
  const previousPath = 'src/content/blog/previous-test.md';
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, previous_filename: previousPath, status: 'renamed' }]);
  gh.getFile.mockImplementation(async (name, sha) => {
    if (name.endsWith('.json')) return { content: '{}' };
    if (sha === 'base-sha') return { content: '---\ntitle: Test\nmetaDescription: Exact camel base value\nmeta_description: Lower-priority snake value\n---\nBase body' };
    return { content: '---\ntitle: Test\nmetaDescription: Call now for a special offer\n---\nTest body' };
  });
  editorial.prepareDraft.mockResolvedValue({ body: 'Test body' });
  validateFixedBlogFile.mockResolvedValue({ ok: true, requiresHumanReview: false });

  expect(await reviewPr(1)).toMatchObject({ pass: true, requiresFreshBuild: true });
  expect(gh.getFile).toHaveBeenCalledWith(previousPath, 'base-sha');
  expect(validateFixedBlogFile).toHaveBeenCalledWith(expect.any(String), {
    originalMetaDescription: 'Exact camel base value',
    requireFactCheck: true,
  });
});

test('a newly added hand-authored article explicitly disables metadata grandfathering without a base read', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, ref: 'article/new' } });
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'added' }]);
  gh.getFile.mockImplementation(async (name) => ({ content: name.endsWith('.json')
    ? '{}'
    : '---\ntitle: Test\nmeta_description: Call now for a special offer\n---\nTest body' }));
  editorial.prepareDraft.mockResolvedValue({ body: 'Test body' });
  validateFixedBlogFile.mockResolvedValue({ ok: true, requiresHumanReview: false });

  expect(await reviewPr(1)).toMatchObject({ pass: true, requiresFreshBuild: true });
  expect(validateFixedBlogFile).toHaveBeenCalledWith(expect.any(String), {
    originalMetaDescription: '',
    requireFactCheck: true,
  });
  expect(gh.getFile).not.toHaveBeenCalledWith(path, 'base-sha');
});

test('a hand-authored PR without an immutable base SHA fails closed', async () => {
  gh.getPr.mockResolvedValue({
    ...pr,
    head: { ...pr.head, ref: 'article/test' },
    base: { ref: 'main' },
  });

  await expect(reviewPr(1)).rejects.toThrow(/base.sha/);
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
  expect(validateFixedBlogFile).not.toHaveBeenCalled();
  expect(gh.commitFiles).not.toHaveBeenCalled();
});

test('a missing modified-file base revision fails closed before validation', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, ref: 'article/test' } });
  gh.getFile.mockImplementation(async (name, sha) => {
    if (name.endsWith('.json')) return { content: '{}' };
    if (sha === 'base-sha') return null;
    return { content: '---\ntitle: Test\nmeta_description: Proposed metadata\n---\nTest body' };
  });

  await expect(reviewPr(1)).resolves.toEqual(expect.objectContaining({
    pass: false,
    deferred: true,
    failures: [expect.objectContaining({ reason: expect.stringContaining('reviewed base') })],
  }));
  expect(validateFixedBlogFile).not.toHaveBeenCalled();
  expect(gh.commitFiles).not.toHaveBeenCalled();
});

test('scheduled review recovers unsigned PRs opened before activation or during an outage', async () => {
  gh.ghFetchPaginated.mockImplementation(async (url) => url.includes('?state=open') ? [pr] : [{ filename: path, status: 'modified' }]);
  contract.verifyManifest.mockReturnValue({ pass: false });
  const result = await refreshStale({ now: 0 });
  expect(result.results).toEqual([expect.objectContaining({ pr: 1, pass: true })]);
  expect(gh.commitFiles).toHaveBeenCalledTimes(1);
});

test('an unreadable article consumes one slot without starving later PRs across ticks', async () => {
  const prs = Array.from({ length: 6 }, (_, i) => ({ ...pr, number: i + 1, head: { ...pr.head, sha: `head-${i + 1}` } }));
  gh.ghFetchPaginated.mockImplementation(async (url) => url.includes('?state=open') ? prs : [{ filename: path, status: 'modified' }]);
  gh.getPr.mockImplementation(async (number) => prs[number - 1]);
  gh.getFile.mockImplementation(async (name, sha) => ({ content: sha === 'head-1' ? '' : name.endsWith('.json') ? '{}' : 'Test body' }));
  const first = await refreshStale({ now: 0 });
  const second = await refreshStale({ now: 1800000 });
  expect(first.results).toEqual([
    expect.objectContaining({ pr: 1, pass: false, deferred: true }),
    expect.objectContaining({ pr: 2, pass: true }),
    expect.objectContaining({ pr: 3, pass: true }),
  ]);
  expect(second.results.map((item) => item.pr)).toEqual([4, 5, 6]);
  expect(gh.commitFiles).toHaveBeenCalledTimes(5);
});

test('verifies spoke evidence under the article frontmatter domain, not the hub', async () => {
  editorial.evidenceDomain.mockReturnValue('spoke.example');
  contract.verifyManifest.mockReturnValue({ pass: true });
  await expect(reviewPr(1)).resolves.toEqual({ pass: true, unchanged: true });
  expect(contract.verifyManifest).toHaveBeenCalledWith(expect.objectContaining({ domain: 'spoke.example' }));
});
test('an unresolvable article domain never verifies and gets a fresh review', async () => {
  editorial.evidenceDomain.mockReturnValue(null);
  contract.verifyManifest.mockReturnValue({ pass: true });
  await reviewPr(1);
  expect(contract.verifyManifest).not.toHaveBeenCalled();
  expect(editorial.filesForDocument).toHaveBeenCalled();
});
