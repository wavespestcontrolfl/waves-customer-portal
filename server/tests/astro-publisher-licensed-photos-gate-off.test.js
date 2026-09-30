/**
 * GATE_BLOG_BODY_IMAGES off (its default). Identification photos are
 * licensed-library files already committed in the Astro repo and embedded
 * by local path (Codex r3 on #5216), so there is nothing for the publisher
 * to fetch or re-host with the gate off either: the body passes through
 * untouched and the gate keeps controlling AI generation only. Codex r6:
 * those library photos are still checked to be committed and pinned.
 */

delete process.env.GATE_BLOG_BODY_IMAGES;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn().mockResolvedValue(null),
  listDir: jest.fn().mockResolvedValue([]),
}));

const gh = require('../services/content-astro/github-client');
const pub = require('../services/content-astro/astro-publisher');
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');

const { resolveBodyImages, assertBodyImagesAtHead } = pub._internals;
const PHOTO = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant');

afterEach(() => { delete global.fetch; gh.getFile.mockReset(); gh.getFile.mockResolvedValue(null); });

test('the gate really is off in this suite', () => {
  expect(require('../config/feature-gates').isEnabled('blogBodyImages')).toBe(false);
});

test('a diagnostic draft with a library photo ships its local path unchanged — no fetch, no files, the photo pinned', async () => {
  global.fetch = jest.fn();
  gh.getFile.mockImplementation(async (path) => (path === `public${PHOTO.src}` ? { content: 'x', sha: 'photo-sha' } : null));
  const body = ['Intro prose.', '', `![${PHOTO.alt}](${PHOTO.src})`, '', photoAttributionLine(PHOTO)].join('\n');
  const result = await resolveBodyImages({
    frontmatter: { post_type: 'diagnostic', title: 'Identification' },
    slug: 'pest-control/id-post', body, existingFile: null, brief: {}, mdx: true,
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ body, files: [], images: [], pinned: [{ repoPath: `public${PHOTO.src}`, sha: 'photo-sha' }] });
});

// Codex r6 on #5216 ("Validate licensed assets when image generation is
// disabled"): a catalog entry whose asset is not (or no longer) committed
// parks instead of publishing a broken image.
test('with the gate OFF a diagnostic photo that is not committed in the Astro repo parks', async () => {
  const body = ['Intro prose.', '', `![${PHOTO.alt}](${PHOTO.src})`, '', photoAttributionLine(PHOTO)].join('\n');
  await expect(resolveBodyImages({
    frontmatter: { post_type: 'diagnostic', title: 'Identification' },
    slug: 'pest-control/id-post', body, existingFile: null, brief: {}, mdx: true,
  })).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
});

test('with the gate OFF a non-identification post is untouched and unchecked', async () => {
  const body = 'Intro.\n\n![Some picture](/images/blog/other/missing.webp)';
  const result = await resolveBodyImages({ frontmatter: { post_type: 'how-to', title: 'How to' }, slug: 'pest-control/how', body, existingFile: null, brief: {}, mdx: true });
  expect(result).toMatchObject({ body, files: [], pinned: [] });
  expect(gh.getFile).not.toHaveBeenCalled();
});

test('the merge-time check stays a no-op with the gate OFF', async () => {
  expect(await assertBodyImagesAtHead({ frontmatter: {}, branch: 'b' })).toEqual({ ok: true, reason: 'gate_off' });
});

// Codex r9 on #5216 ("Revalidate pinned diagnostic photos at merge time"):
// with the gate off, identification posts still get the as-merged check.
describe('merge-time check with the gate OFF', () => {
  test('a non-identification post stays a no-op', async () => {
    expect(await assertBodyImagesAtHead({ frontmatter: { post_type: 'how-to' }, branch: 'b' })).toEqual({ ok: true, reason: 'gate_off' });
  });
  test('an identification post runs the full as-merged check (here: its file is missing on the branch)', async () => {
    const r = await assertBodyImagesAtHead({ frontmatter: { post_type: 'diagnostic', title: 'Fire ants', slug: 'fire-ant-id', category: 'pest-control' }, branch: 'b' });
    expect(r.ok).toBe(false);
    expect(r.reason).not.toBe('gate_off');
  });
});

