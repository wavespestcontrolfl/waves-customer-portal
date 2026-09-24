const crypto = require('crypto');
jest.mock('../services/content/editorial-review', () => ({ review: jest.fn(), repair: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ env: jest.fn(() => ({ owner: 'waves', repo: 'astro' })), ghFetchPaginated: jest.fn(), getFile: jest.fn() }));
const reviewer = require('../services/content/editorial-review');
const gh = require('../services/content-astro/github-client');
const evidence = require('../services/content/editorial-evidence');
const contract = require('../../packages/editorial-evidence/index.cjs');
const fm = require('../services/content-astro/frontmatter');

const document = fm.stringify({ title: 'How to inspect a door' }, 'Inspect the door seal for gaps.');
const path = 'src/content/blog/door.mdx';
const keys = crypto.generateKeyPairSync('ed25519');
const originalEnv = { ...process.env };
function passing() {
  return { pass: true, model: 'test-reviewer', reviewedAt: new Date().toISOString(), sources: [],
    checks: contract.REQUIRED_CHECKS.map((name) => ({ name, status: 'pass', findings: [] })) };
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_EDITORIAL_EVIDENCE = 'true';
  process.env.EDITORIAL_REVIEW_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.EDITORIAL_REVIEW_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' });
  reviewer.review.mockResolvedValue(passing());
});
afterAll(() => { process.env = originalEnv; });

test('dark gate makes no model calls or evidence writes', async () => {
  process.env.GATE_EDITORIAL_EVIDENCE = 'false';
  expect(await evidence.filesForDocument({ document, path })).toEqual([]);
  expect(reviewer.review).not.toHaveBeenCalled();
});
test('signs exact final bytes and rejects a later edit at immutable PR head', async () => {
  const [file] = await evidence.filesForDocument({ document, path });
  expect(file.path).toBe(contract.evidencePath(path));
  expect(contract.verifyManifest({ document, path, domain: 'wavespestcontrol.com', manifest: JSON.parse(file.content), publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY }).pass).toBe(true);
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'modified' }]);
  gh.getFile.mockImplementation(async (name) => name === path ? { content: document + 'Unreviewed claim.' } : file);
  await expect(evidence.assertPrEvidence({ number: 7, head: { sha: 'exact-sha' } })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  expect(gh.getFile).toHaveBeenCalledWith(path, 'exact-sha');
});
test('missing signing key cannot silently publish or spend model calls', async () => {
  delete process.env.EDITORIAL_REVIEW_PRIVATE_KEY;
  await expect(evidence.filesForDocument({ document, path })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  expect(reviewer.review).not.toHaveBeenCalled();
});
test('writer pass flag cannot override incomplete mandatory results', async () => {
  reviewer.review.mockResolvedValue({ ...passing(), checks: [] });
  await expect(evidence.filesForDocument({ document, path })).rejects.toThrow();
});
test('repairs before returning draft and requires another independent review', async () => {
  const failed = passing();
  failed.pass = false;
  failed.checks[0] = { name: 'answer_first', status: 'fail', findings: [{ passage: 'Inspect', action: 'Answer directly.' }] };
  reviewer.review.mockResolvedValueOnce(failed).mockResolvedValueOnce(passing());
  reviewer.repair.mockResolvedValue(fm.stringify({ title: 'How to inspect a door' }, 'Look for daylight around the closed door.'));
  const result = await evidence.prepareDraft({ frontmatter: { title: 'How to inspect a door' }, body: 'Inspect' }, { page_type: 'supporting-blog' });
  expect(result.body).toContain('Look for daylight');
  expect(reviewer.review).toHaveBeenCalledTimes(2);
  expect(reviewer.repair).toHaveBeenCalledTimes(1);
});
test('an exhausted repair fails with directives instead of requiring approval', async () => {
  const failed = { ...passing(), pass: false, checks: [{ name: 'source_support', status: 'fail', findings: [{ passage: 'Claim', action: 'Remove unsupported claim.' }] }] };
  reviewer.review.mockResolvedValue(failed);
  reviewer.repair.mockResolvedValue(document);
  await expect(evidence.prepareDraft({ frontmatter: { title: 'How to inspect a door' }, body: 'Claim' }, { page_type: 'supporting-blog' })).rejects.toMatchObject({
    code: 'BLOG_EDITORIAL_REVIEW_FAILED', findings: [expect.objectContaining({ message: expect.stringContaining('Remove unsupported claim') })],
  });
  expect(reviewer.review).toHaveBeenCalledTimes(2);
});
test('source extraction ignores image assets and fleet links, deduplicates evidence', () => {
  expect(evidence.sourceUrls('[IFAS](https://edis.ifas.ufl.edu/fact) ![x](https://example.org/x.webp) https://wavespestcontrol.com/about',
    { required_sources: ['https://edis.ifas.ufl.edu/fact'] })).toEqual(['https://edis.ifas.ufl.edu/fact']);
});
