const crypto = require('crypto');
jest.mock('../services/content/editorial-review', () => ({ review: jest.fn(), repair: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ env: jest.fn(() => ({ owner: 'waves', repo: 'astro' })), getPr: jest.fn(), ghFetchPaginated: jest.fn(), getFile: jest.fn(), compareFiles: jest.fn() }));
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
  await expect(evidence.assertPrEvidence({ number: 7, head: { sha: 'exact-sha' } })).resolves.toBeUndefined();
  expect(gh.getPr).not.toHaveBeenCalled();
});
test('signs exact final bytes and rejects a later edit at immutable PR head', async () => {
  const [file] = await evidence.filesForDocument({ document, path });
  expect(file.path).toBe(contract.evidencePath(path));
  expect(contract.verifyManifest({ document, path, domain: 'wavespestcontrol.com', manifest: JSON.parse(file.content), publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY }).pass).toBe(true);
  gh.getPr.mockResolvedValue({ state: 'open', head: { sha: 'exact-sha' }, base: { sha: 'base-sha', ref: 'main' } });
  gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'modified' }]);
  gh.compareFiles.mockResolvedValue({ mergeBaseSha: 'fork-sha', files: [path, file.path] });
  gh.getFile.mockImplementation(async (name, ref) => {
    if (ref === 'fork-sha' || ref === 'base-sha') return { sha: 'unchanged-article' };
    return name === path ? { content: document + 'Unreviewed claim.' } : file;
  });
  await expect(evidence.assertPrEvidence({ number: 7, head: { sha: 'exact-sha' } })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  expect(gh.getFile).toHaveBeenCalledWith(path, 'exact-sha');
});
describe('merge-output evidence proof', () => {
  const headSha = '1'.repeat(40);
  const baseSha = '2'.repeat(40);
  const mergeBaseSha = '3'.repeat(40);

  async function arrangeSignedArticle() {
    const sidecar = (await evidence.filesForDocument({ document, path }))[0];
    gh.getPr.mockResolvedValue({ state: 'open', head: { sha: headSha }, base: { sha: baseSha, ref: 'main' } });
    gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'modified' }]);
    gh.compareFiles.mockResolvedValue({ mergeBaseSha, files: [path, sidecar.path] });
    return sidecar;
  }

  test('allows an unrelated base advance when the article blob is unchanged', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.getFile.mockImplementation(async (name, ref) => {
      if (ref === mergeBaseSha || ref === baseSha) return { sha: 'same-article-blob' };
      return name === path ? { content: document } : sidecar;
    });

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .resolves.toEqual({ baseSha, baseRef: 'main', articlePaths: [path] });
    expect(gh.compareFiles).toHaveBeenCalledWith(headSha, baseSha);
  });

  test('verifies a sidecar changed without its article and pins that article for the merge', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.ghFetchPaginated.mockResolvedValue([{ filename: sidecar.path, status: 'modified' }]);
    gh.getFile.mockImplementation(async (name) => (name === path ? { content: document } : sidecar));

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .resolves.toEqual({ baseSha, baseRef: 'main', articlePaths: [path] });
  });

  test('rejects a sidecar changed without its article when it no longer verifies', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.ghFetchPaginated.mockResolvedValue([{ filename: sidecar.path, status: 'modified' }]);
    gh.getFile.mockImplementation(async (name) => (name === path ? { content: document + 'Tampered.' } : sidecar));

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  });

  test('rejects a removed evidence sidecar', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.ghFetchPaginated.mockResolvedValue([{ filename: sidecar.path, status: 'removed' }]);
    gh.getFile.mockImplementation(async (name) => (name === path ? { content: document } : sidecar));

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  });

  test('allows a new article when its path is absent from both fork and current base', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.ghFetchPaginated.mockResolvedValue([{ filename: path, status: 'added' }]);
    gh.getFile.mockImplementation(async (name, ref) => {
      if ((ref === mergeBaseSha || ref === baseSha) && name === path) return null;
      return name === path ? { content: document } : sidecar;
    });

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .resolves.toEqual({ baseSha, baseRef: 'main', articlePaths: [path] });
  });

  test('rejects a clean non-overlapping base edit to the reviewed article', async () => {
    const sidecar = await arrangeSignedArticle();
    gh.getFile.mockImplementation(async (name, ref) => {
      if (ref === mergeBaseSha) return { sha: 'fork-article-blob' };
      if (ref === baseSha) return { sha: 'edited-base-article-blob' };
      return name === path ? { content: document } : sidecar;
    });

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
    expect(gh.getFile).not.toHaveBeenCalledWith(path, headSha);
  });

  test('rejects a base edit to the source of a renamed article', async () => {
    const oldPath = 'src/content/blog/old-door.mdx';
    await arrangeSignedArticle();
    gh.ghFetchPaginated.mockResolvedValue([{
      filename: path, previous_filename: oldPath, status: 'renamed',
    }]);
    gh.getFile.mockImplementation(async (name, ref) => {
      if (name === path && (ref === mergeBaseSha || ref === baseSha)) return null;
      if (name === oldPath && ref === mergeBaseSha) return { sha: 'old-fork-blob' };
      if (name === oldPath && ref === baseSha) return { sha: 'old-base-edit' };
      throw new Error(`unexpected read ${name}@${ref}`);
    });

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
    expect(gh.getFile).not.toHaveBeenCalledWith(path, headSha);
  });

  test.each([
    ['the current PR base is unavailable', { current: { state: 'open', head: { sha: headSha } } }],
    ['the merge base is unavailable', { compared: { files: [path] } }],
    ['either base blob lacks an authenticated SHA', { missingBlobSha: true }],
  ])('fails closed when %s', async (_label, options) => {
    const sidecar = await arrangeSignedArticle();
    if (options.current) gh.getPr.mockResolvedValue(options.current);
    if (options.compared) gh.compareFiles.mockResolvedValue(options.compared);
    gh.getFile.mockImplementation(async (name, ref) => {
      if (ref === mergeBaseSha) return options.missingBlobSha ? { content: document } : { sha: 'same-article-blob' };
      if (ref === baseSha) return { sha: 'same-article-blob' };
      return name === path ? { content: document } : sidecar;
    });

    await expect(evidence.assertPrEvidence({ number: 7, head: { sha: headSha } }))
      .rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  });
});
describe('publisher-pin evidence-only descendants', () => {
  const pinnedSha = '1'.repeat(40);
  const headSha = '2'.repeat(40);

  async function signedSidecar() {
    return (await evidence.filesForDocument({ document, path }))[0];
  }

  test('accepts a strict descendant containing only a canonical fresh sidecar for the exact head article', async () => {
    const sidecar = await signedSidecar();
    gh.compareFiles.mockResolvedValue({ mergeBaseSha: pinnedSha, files: [sidecar.path] });
    gh.getFile.mockImplementation(async (name, ref) => {
      expect(ref).toBe(headSha);
      return name === path ? { content: document } : sidecar;
    });

    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha, headSha })).resolves.toBe(true);
    expect(gh.compareFiles).toHaveBeenCalledWith(headSha, pinnedSha);
  });

  test('rejects an article edit beyond a human-approved anchor even when a valid sidecar is also present', async () => {
    const approvedSha = '3'.repeat(40);
    const sidecar = await signedSidecar();
    gh.compareFiles.mockResolvedValue({ mergeBaseSha: approvedSha, files: [path, sidecar.path] });

    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha: approvedSha, headSha })).resolves.toBe(false);
    expect(gh.getFile).not.toHaveBeenCalled();
  });

  test.each([
    ['an article change', () => [path]],
    ['an unrelated file', () => ['README.md']],
    ['a deletion or rename source whose old path is absent', (sidecar) => [sidecar.path], { missingSidecar: true }],
    ['a divergent branch', (sidecar) => [sidecar.path], { mergeBaseSha: '3'.repeat(40) }],
    ['the compare API file cap', () => Array.from({ length: 300 }, (_, i) => `content-ops/editorial-evidence/${i.toString(16).padStart(64, '0')}.json`)],
  ])('rejects %s', async (_label, filesFor, options = {}) => {
    const sidecar = await signedSidecar();
    gh.compareFiles.mockResolvedValue({
      mergeBaseSha: options.mergeBaseSha || pinnedSha,
      files: filesFor(sidecar),
    });
    gh.getFile.mockImplementation(async (name) => {
      if (options.missingSidecar && name === sidecar.path) return null;
      return name === path ? { content: document } : sidecar;
    });
    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha, headSha })).resolves.toBe(false);
  });

  test('rejects a sidecar with an invalid signature', async () => {
    const sidecar = await signedSidecar();
    const manifest = JSON.parse(sidecar.content);
    manifest.signature.value = Buffer.alloc(64).toString('base64');
    const tampered = { ...sidecar, content: `${JSON.stringify(manifest)}\n` };
    gh.compareFiles.mockResolvedValue({ mergeBaseSha: pinnedSha, files: [sidecar.path] });
    gh.getFile.mockImplementation(async (name) => name === path ? { content: document } : tampered);

    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha, headSha })).resolves.toBe(false);
  });

  test('rejects a correctly signed but stale sidecar', async () => {
    const staleManifest = contract.createManifest({ document, path, domain: 'wavespestcontrol.com',
      checks: passing().checks, sources: [], reviewedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
      model: 'test-reviewer', privateKey: process.env.EDITORIAL_REVIEW_PRIVATE_KEY });
    const sidecar = { path: contract.evidencePath(path), content: JSON.stringify(staleManifest) };
    gh.compareFiles.mockResolvedValue({ mergeBaseSha: pinnedSha, files: [sidecar.path] });
    gh.getFile.mockImplementation(async (name) => name === path ? { content: document } : sidecar);

    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha, headSha })).resolves.toBe(false);
  });

  test('rejects a compare response without complete ancestry/file fields', async () => {
    gh.compareFiles.mockResolvedValue({ files: [] });
    await expect(evidence.verifyEvidenceOnlyAdvance({ pinnedSha, headSha })).resolves.toBe(false);
    expect(gh.getFile).not.toHaveBeenCalled();
  });
});
test('missing signing key cannot silently publish or spend model calls', async () => {
  delete process.env.EDITORIAL_REVIEW_PRIVATE_KEY;
  await expect(evidence.filesForDocument({ document, path })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
  expect(reviewer.review).not.toHaveBeenCalled();
});
test('malformed private key material is classified as an editorial outage, not a crash', async () => {
  process.env.EDITORIAL_REVIEW_PRIVATE_KEY = 'not-valid-pem-or-der';
  await expect(evidence.filesForDocument({ document, path })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
});
describe('review domain follows the article\'s own frontmatter domains', () => {
  test('signs and verifies under the single spoke domain the article targets', async () => {
    const spokeDocument = fm.stringify({ title: 'Bradenton door guide', domains: ['bradentonfllawncare.com'] }, 'Inspect the door seal for gaps.');
    const [file] = await evidence.filesForDocument({ document: spokeDocument, path });
    const manifest = JSON.parse(file.content);
    expect(manifest.domain).toBe('bradentonfllawncare.com');
    expect(contract.verifyManifest({ document: spokeDocument, path, domain: 'bradentonfllawncare.com',
      manifest, publicKey: process.env.EDITORIAL_REVIEW_PUBLIC_KEY }).pass).toBe(true);
    expect(reviewer.review).toHaveBeenCalledWith(expect.objectContaining({ domain: expect.objectContaining({
      hostname: 'bradentonfllawncare.com', tokens: expect.objectContaining({ siteUrl: 'https://www.bradentonfllawncare.com' }) }) }));
  });
  test('falls back to the hub for hub-only or absent domains', async () => {
    const hubDocument = fm.stringify({ title: 'Hub door guide', domains: ['wavespestcontrol.com'] }, 'Inspect the door seal for gaps.');
    const [file] = await evidence.filesForDocument({ document: hubDocument, path });
    expect(JSON.parse(file.content).domain).toBe('wavespestcontrol.com');
  });
  test('fails closed on more than one domain, spending no model call', async () => {
    const ambiguous = fm.stringify({ title: 'Ambiguous', domains: ['bradentonfllawncare.com', 'sarasotafllawncare.com'] }, 'Body.');
    await expect(evidence.filesForDocument({ document: ambiguous, path })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
    expect(reviewer.review).not.toHaveBeenCalled();
  });
  test('fails closed on a domain outside the fleet, spending no model call', async () => {
    const unknown = fm.stringify({ title: 'Unknown', domains: ['example.com'] }, 'Body.');
    await expect(evidence.filesForDocument({ document: unknown, path })).rejects.toMatchObject({ code: 'BLOG_EDITORIAL_REVIEW_UNAVAILABLE' });
    expect(reviewer.review).not.toHaveBeenCalled();
  });
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
  const factsPack = { evidence_strength: 'supported', disallowed_claims: ['guaranteed prevention'] };
  const result = await evidence.prepareDraft({ frontmatter, body: 'Inspect' }, {
    page_type: 'supporting-blog', facts_pack: factsPack,
  });
  expect(result.body).toContain('Look for daylight');
  expect(result.frontmatter).toBe(frontmatter);
  expect(publisher.resolveExistingAstroFileForTarget).not.toHaveBeenCalled();
  expect(reviewer.review).toHaveBeenCalledTimes(2);
  expect(reviewer.repair).toHaveBeenCalledTimes(1);
  expect(reviewer.repair).toHaveBeenCalledWith(expect.objectContaining({ factsPack }));
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
test('source extraction preserves a balanced parenthesis inside a URL and trims only an unmatched wrapping one', () => {
  expect(evidence.sourceUrls('Per the report at https://example.org/report_(2026) prevalence rose.'))
    .toEqual(['https://example.org/report_(2026)']);
  expect(evidence.sourceUrls('(see https://a.org/x)')).toEqual(['https://a.org/x']);
  expect(evidence.sourceUrls('[x](https://a.org/b_(c))')).toEqual(['https://a.org/b_(c)']);
});
