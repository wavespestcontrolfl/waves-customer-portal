const crypto = require('crypto');
jest.mock('../services/content/editorial-review', () => ({ review: jest.fn(), repair: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ env: jest.fn(() => ({ owner: 'waves', repo: 'astro' })), ghFetchPaginated: jest.fn(), getFile: jest.fn() }));
jest.mock('../services/content-astro/astro-publisher', () => ({ resolveExistingAstroFileForTarget: jest.fn() }));
const reviewer = require('../services/content/editorial-review');
const gh = require('../services/content-astro/github-client');
const publisher = require('../services/content-astro/astro-publisher');
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
  publisher.resolveExistingAstroFileForTarget.mockReset();
  process.env.GATE_EDITORIAL_EVIDENCE = 'true';
  process.env.EDITORIAL_REVIEW_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.EDITORIAL_REVIEW_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' });
  reviewer.review.mockResolvedValue(passing());
});
afterAll(() => { process.env = originalEnv; });

test('dark gate makes no model calls or evidence writes', async () => {
  process.env.GATE_EDITORIAL_EVIDENCE = 'false';
  expect(await evidence.filesForDocument({ document, path })).toEqual([]);
  const draft = { type: 'draft', page_url: 'https://www.wavespestcontrol.com/pest-control/door/', frontmatter: {}, body: 'Inspect' };
  expect(await evidence.prepareDraft(draft, { page_type: 'refresh', action_type: 'refresh_existing_page' })).toBe(draft);
  expect(publisher.resolveExistingAstroFileForTarget).not.toHaveBeenCalled();
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
  const frontmatter = { title: 'How to inspect a door' };
  const result = await evidence.prepareDraft({ frontmatter, body: 'Inspect' }, { page_type: 'supporting-blog' });
  expect(result.body).toContain('Look for daylight');
  expect(result.frontmatter).toBe(frontmatter);
  expect(publisher.resolveExistingAstroFileForTarget).not.toHaveBeenCalled();
  expect(reviewer.review).toHaveBeenCalledTimes(2);
  expect(reviewer.repair).toHaveBeenCalledTimes(1);
});
test.each([
  ['an explicit file_path', { file_path: path }, path],
  ['the brief target URL', {}, 'https://www.wavespestcontrol.com/pest-control/door/'],
])('resolves and repairs a blog refresh through %s before the legacy gates run', async (_label, targetFields, expectedTarget) => {
  const failed = passing();
  failed.pass = false;
  failed.checks[0] = { name: 'answer_first', status: 'fail', findings: [{ passage: 'Inspect', action: 'Answer directly.' }] };
  reviewer.review.mockResolvedValueOnce(failed).mockResolvedValueOnce(passing());
  reviewer.repair.mockResolvedValue(fm.stringify({ title: 'How to inspect a door' }, 'Look for daylight around the closed door.'));
  publisher.resolveExistingAstroFileForTarget.mockResolvedValue({ path, file: { content: document } });
  const frontmatter = {};
  const draft = {
    type: 'draft',
    ...targetFields,
    page_url: 'https://www.wavespestcontrol.com/pest-control/wrong-fallback/',
    frontmatter,
    body: 'Inspect',
  };
  const result = await evidence.prepareDraft(draft, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    target_url: 'https://www.wavespestcontrol.com/pest-control/door/',
  });
  expect(publisher.resolveExistingAstroFileForTarget).toHaveBeenCalledWith(expectedTarget);
  expect(result.body).toContain('Look for daylight');
  expect(result.frontmatter).toBe(frontmatter);
  expect(reviewer.review).toHaveBeenNthCalledWith(1, expect.objectContaining({ title: 'How to inspect a door' }));
  expect(reviewer.repair).toHaveBeenCalledWith(expect.objectContaining({ title: 'How to inspect a door' }));
  expect(reviewer.review).toHaveBeenCalledTimes(2);
  expect(reviewer.repair).toHaveBeenCalledTimes(1);
});
test('reviews only publisher-permitted refresh metadata overrides against live immutable frontmatter', async () => {
  const liveFrontmatter = {
    title: 'Live title',
    meta_description: 'Live snake description',
    metaDescription: 'Live camel description',
    category: 'Pest Control',
    canonical: 'https://www.wavespestcontrol.com/blog/door/',
    hero_image: { src: '/images/live.webp', alt: 'Live alt' },
  };
  publisher.resolveExistingAstroFileForTarget.mockResolvedValue({
    path,
    file: { content: fm.stringify(liveFrontmatter, 'Live body.') },
  });
  const frontmatter = {
    title: '  Draft title  ',
    metaTitle: 'Must not introduce an absent field',
    meta_description: '   ',
    metaDescription: '  Draft camel description  ',
    category: 'Changed category',
    canonical: 'https://attacker.example/wrong/',
    hero_image: { src: '/images/wrong.webp', alt: 'Wrong alt' },
  };
  const draft = { type: 'draft', page_url: '/blog/door/', frontmatter, body: 'Updated body.' };

  const result = await evidence.prepareDraft(draft, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    target_url: '/blog/door/',
  });

  const reviewed = fm.parse(reviewer.review.mock.calls[0][0].document);
  expect(reviewed.data).toEqual({
    ...liveFrontmatter,
    title: 'Draft title',
    metaDescription: 'Draft camel description',
  });
  expect(reviewed.data.metaTitle).toBeUndefined();
  expect(reviewer.review).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft title' }));
  expect(result.frontmatter).toBe(frontmatter);
  expect(result.body).toBe('Updated body.');
});
test('resolves but skips editorial review for a non-blog refresh target', async () => {
  publisher.resolveExistingAstroFileForTarget.mockResolvedValue({
    path: 'src/content/services/pest-control-venice-fl.md',
    file: { content: '---\nmetaTitle: Pest Control\n---\n\nService body.' },
  });
  const draft = {
    type: 'draft',
    page_url: 'https://www.wavespestcontrol.com/pest-control-venice-fl/',
    frontmatter: {},
    body: 'Updated service body.',
  };
  const result = await evidence.prepareDraft(draft, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    target_url: 'https://www.wavespestcontrol.com/pest-control-venice-fl/',
  });
  expect(result).toBe(draft);
  expect(publisher.resolveExistingAstroFileForTarget).toHaveBeenCalledWith('https://www.wavespestcontrol.com/pest-control-venice-fl/');
  expect(reviewer.review).not.toHaveBeenCalled();
  expect(reviewer.repair).not.toHaveBeenCalled();
});
test.each([
  ['returns no file', () => publisher.resolveExistingAstroFileForTarget.mockResolvedValue(null)],
  ['returns a path without file content', () => publisher.resolveExistingAstroFileForTarget.mockResolvedValue({ path })],
  ['throws', () => publisher.resolveExistingAstroFileForTarget.mockRejectedValue(new Error('repository read failed'))],
])('fails closed when the refresh resolver %s', async (_label, arrangeResolver) => {
  arrangeResolver();
  await expect(evidence.prepareDraft({
    type: 'draft',
    page_url: 'https://www.wavespestcontrol.com/pest-control/missing/',
    frontmatter: {},
    body: 'Updated body.',
  }, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
  })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  expect(reviewer.review).not.toHaveBeenCalled();
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
