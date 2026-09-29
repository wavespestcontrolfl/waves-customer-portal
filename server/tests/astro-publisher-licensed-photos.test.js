/**
 * Licensed identification photos in the Astro publisher (C3; Codex r3 on
 * #5216). Photos are licensed-library files ALREADY COMMITTED in the Astro
 * repo, embedded by local path — the publisher never fetches, converts or
 * re-hosts anything. It only has to:
 *   - never generate an AI body image for an identification post,
 *   - never strip a library photo in the refresh stale-image pass,
 *   - exempt identification posts from the merge-time image minimum,
 * all through the shared predicates in licensed-photo-library.js.
 */

process.env.GATE_BLOG_BODY_IMAGES = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn().mockResolvedValue(null),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
  listDir: jest.fn().mockResolvedValue([]),
}));

const gh = require('../services/content-astro/github-client');
const pub = require('../services/content-astro/astro-publisher');
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');

const { resolveBodyImages } = pub._internals;
const PHOTO = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant');
const MOUND = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant-mound');

async function tinyWebpBase64(r) {
  const sharp = require('sharp');
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r, g: 40, b: 200 - r } } })
    .composite([{ input: Buffer.from(`<svg width="64" height="64"><rect x="${r % 40}" y="8" width="20" height="40" fill="white"/></svg>`), top: 0, left: 0 }])
    .webp().toBuffer();
  return buf.toString('base64');
}

// The committed Astro files for the library photos (distinct pictures).
async function mockCommittedLibraryFiles() {
  const files = new Map([
    [`public${PHOTO.src}`, { raw: { content: await tinyWebpBase64(10), sha: 'p1' }, sha: 'p1' }],
    [`public${MOUND.src}`, { raw: { content: await tinyWebpBase64(150), sha: 'p2' }, sha: 'p2' }],
  ]);
  gh.getFile.mockImplementation(async (path) => files.get(path) || null);
}

afterEach(() => {
  delete global.fetch;
  jest.clearAllMocks();
  gh.getFile.mockReset();
  gh.getFile.mockResolvedValue(null);
  gh.listDir.mockResolvedValue([]);
});

function diagnosticBody(photos) {
  return [
    '<BottomLineBox verdict="Yes, fire ants sting." recommendation="Keep kids off the mound." />',
    '',
    '## What they look like',
    '',
    'Reddish workers on sandy soil.',
    '',
    ...photos.flatMap((p) => [`![${p.alt}](${p.src})`, '', photoAttributionLine(p), '']),
    '## Where you find them',
    '',
    'Open, sunny lawns.',
  ].join('\n');
}

describe('resolveBodyImages — identification posts', () => {
  test('a library photo publishes by its committed local path: no fetch, no new files, no generation', async () => {
    await mockCommittedLibraryFiles();
    global.fetch = jest.fn();
    const body = diagnosticBody([PHOTO]);
    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification' },
      slug: 'pest-control/fire-ant-id', body, existingFile: null, brief: {}, siblings: [], mdx: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
    expect(result.newAlts).toEqual([]);
  });

  test('a diagnostic post with NO photo publishes with zero body images — never generated art', async () => {
    global.fetch = jest.fn();
    const body = diagnosticBody([]);
    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification' },
      slug: 'pest-control/fire-ant-id', body, existingFile: null, brief: {}, siblings: [], mdx: true,
    });
    expect(result.files).toEqual([]);
    expect(result.body).toBe(body);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a remote catalog URL is not re-hosted: it fails as an uncommitted image (the gate rejects it upstream)', async () => {
    const body = diagnosticBody([{ ...PHOTO, src: 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg' }]);
    await expect(resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification' },
      slug: 'pest-control/fire-ant-id', body, existingFile: null, brief: {}, siblings: [], mdx: true,
    })).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });

  // Codex r3 on #5216 ("Preserve licensed photos through the stale-image
  // pass"): a refresh that rewrites the section around a library photo
  // keeps the photo; only a stale publisher-managed image is stripped.
  test('the refresh stale-image pass never strips a library photo', async () => {
    await mockCommittedLibraryFiles();
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      '## A rewritten heading',
      '',
      'Rewritten lead prose.',
      '',
      '![an old managed picture](/images/blog/pest-control/fire-ant-id/body-7.webp)',
      '',
      `![${PHOTO.alt}](${PHOTO.src})`,
      '',
      photoAttributionLine(PHOTO),
    ].join('\n');
    const existingFile = {
      path: 'src/content/blog/pest-control/fire-ant-id.mdx',
      file: { content: `---\ntitle: x\n---\n## Old heading\n\nOld prose.\n\n![${PHOTO.alt}](${PHOTO.src})\n\n${photoAttributionLine(PHOTO)}\n` },
    };
    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification' },
      slug: 'pest-control/fire-ant-id', body, existingFile, brief: {}, siblings: [], mdx: true,
    });
    expect(result.body).not.toContain('body-7.webp');
    expect(result.body).toContain(`![${PHOTO.alt}](${PHOTO.src})`);
    expect(result.body).toContain(photoAttributionLine(PHOTO));
  });

  test('the publisher no longer carries any fetch / re-host machinery', () => {
    for (const name of ['rehostLicensedIdentificationPhotos', 'fetchAndVerifyLicensedPhoto', 'assertLicensedPhotoUrlAllowed', 'readCappedResponseBody', 'LICENSED_PHOTO_ALLOWED_HOSTS', 'LICENSED_PHOTO_MAX_BYTES', 'matchLicensedPhotoLine']) {
      expect(pub._internals[name]).toBeUndefined();
    }
  });
});

describe('assertBodyImagesAtHead — diagnostic exemption from the image minimum', () => {
  const { assertBodyImagesAtHead } = pub._internals;
  const FILE = 'src/content/blog/pest-control/fire-ant-id.mdx';
  const post = (postType) => [
    '---',
    'title: Fire Ant Identification',
    `post_type: ${postType}`,
    '---',
    '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
    '',
    'Fire ants build sandy mounds in Florida yards.',
    '',
  ].join('\n');
  afterEach(() => { gh.getFile.mockReset(); gh.getFile.mockResolvedValue(null); });

  test('a diagnostic post with zero body images passes the merge-time check', async () => {
    gh.getFile.mockImplementation(async (path) => (path === FILE ? { content: post('diagnostic'), sha: 'abc' } : null));
    const r = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/x', filePath: FILE });
    expect(r.reason).toBeNull();
    expect(r).toMatchObject({ ok: true });
  });

  test('the same post as a non-diagnostic type is still held to the minimum', async () => {
    gh.getFile.mockImplementation(async (path) => (path === FILE ? { content: post('how-to'), sha: 'abc' } : null));
    const r = await assertBodyImagesAtHead({ frontmatter: {}, branch: 'content/x', filePath: FILE });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/minimum 2/);
  });

  test('publisher and merge-time check share one predicate', () => {
    const { isIdentificationPost } = require('../services/content/licensed-photo-library');
    expect(isIdentificationPost({ post_type: 'diagnostic' })).toBe(true);
    // Exact-case, like the publisher's normalizePostType (Codex r9): a
    // capitalized value ships as 'location', so it is not identification.
    expect(isIdentificationPost({ post_type: ' Diagnostic ' })).toBe(false);
    expect(isIdentificationPost({ page_type: 'diagnostic' })).toBe(true);
    expect(isIdentificationPost({ post_type: 'how-to' })).toBe(false);
    expect(isIdentificationPost(null)).toBe(false);
  });
});
