/**
 * GATE_BLOG_BODY_IMAGES off (its default). Identification photos are
 * licensed-library files already committed in the Astro repo and embedded
 * by local path (Codex r3 on #5216), so there is nothing for the publisher
 * to fetch or re-host with the gate off either: the body passes through
 * untouched and the gate keeps controlling AI generation only.
 */

delete process.env.GATE_BLOG_BODY_IMAGES;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn().mockResolvedValue(null),
  listDir: jest.fn().mockResolvedValue([]),
}));

const pub = require('../services/content-astro/astro-publisher');
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');

const { resolveBodyImages, assertBodyImagesAtHead } = pub._internals;
const PHOTO = PHOTO_LIBRARY.find((e) => e.catalog_slug === 'fire-ant');

afterEach(() => { delete global.fetch; });

test('the gate really is off in this suite', () => {
  expect(require('../config/feature-gates').isEnabled('blogBodyImages')).toBe(false);
});

test('a diagnostic draft with a library photo ships its local path unchanged — no fetch, no files', async () => {
  global.fetch = jest.fn();
  const body = ['Intro prose.', '', `![${PHOTO.alt}](${PHOTO.src})`, '', photoAttributionLine(PHOTO)].join('\n');
  const result = await resolveBodyImages({
    frontmatter: { post_type: 'diagnostic', title: 'Identification' },
    slug: 'pest-control/id-post', body, existingFile: null, brief: {}, mdx: true,
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ body, files: [], images: [] });
});

test('the merge-time check stays a no-op with the gate OFF', async () => {
  expect(await assertBodyImagesAtHead({ frontmatter: {}, branch: 'b' })).toEqual({ ok: true, reason: 'gate_off' });
});
