jest.mock('../services/content/codex-remediation', () => ({ validateFixedBlogFile: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  env: jest.fn(() => ({ owner: 'waves', repo: 'astro', defaultBranch: 'main' })),
  getPr: jest.fn(), ghFetchPaginated: jest.fn(), getFile: jest.fn(), commitFiles: jest.fn(),
}));
jest.mock('../services/content/editorial-evidence', () => ({
  enabled: () => true, applicable: (path) => path.startsWith('src/content/blog/'),
  filesForDocument: jest.fn(), prepareDraft: jest.fn(),
}));
jest.mock('../../packages/editorial-evidence/index.cjs', () => ({
  evidencePath: (path) => `${path}.json`, verifyManifest: jest.fn(),
}));
const gh = require('../services/content-astro/github-client');
const editorial = require('../services/content/editorial-evidence');
const contract = require('../../packages/editorial-evidence/index.cjs');
const { reviewPr, retryReview, refreshStale } = require('../scripts/review-editorial-pr');
const path = 'src/content/blog/test.md';
const pr = { number: 1, state: 'open', head: { sha: 'reviewed-sha', ref: 'content/test', repo: { full_name: 'waves/astro' } }, base: { ref: 'main' } };
beforeEach(() => {
  jest.clearAllMocks();
  gh.getPr.mockResolvedValue(pr);
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'modified' }]);
  gh.getFile.mockImplementation(async (name) => ({ content: name.endsWith('.json') ? '{}' : '---\ntitle: Test\n---\nTest body' }));
  contract.verifyManifest.mockReturnValue({ pass: false });
  editorial.filesForDocument.mockResolvedValue([{ path: `${path}.json`, content: '{}' }]);
  gh.commitFiles.mockResolvedValue({ commit: { sha: 'evidence-sha' } });
});
test('only trusted same-repository PRs may receive evidence', async () => {
  gh.getPr.mockResolvedValue({ ...pr, head: { ...pr.head, repo: { full_name: 'attacker/fork' } } });
  await expect(reviewPr(1)).rejects.toThrow('same-repository');
  expect(editorial.filesForDocument).not.toHaveBeenCalled();
});
test('pins evidence commit to reviewed head and never repairs managed article bytes', async () => {
  expect(await reviewPr(1)).toMatchObject({ pass: true, requiresFreshBuild: true });
  expect(gh.commitFiles).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: 'reviewed-sha' }));
  expect(editorial.prepareDraft).not.toHaveBeenCalled();
});
test('head movement prevents any evidence commit', async () => {
  gh.getPr.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, head: { ...pr.head, sha: 'new-sha' } });
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
