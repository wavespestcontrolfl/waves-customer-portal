/**
 * Codex r2 on #5216 ("Rehost licensed photos even when generated images are
 * disabled"): GATE_BLOG_BODY_IMAGES only controls AI GENERATION. With the
 * gate OFF (its default) a diagnostic draft must still ship the verified
 * local WebP copy of its licensed photo, never a hotlink to the remote
 * catalog URL — and nothing else about the gate-off path changes.
 */

delete process.env.GATE_BLOG_BODY_IMAGES;

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

const pub = require('../services/content-astro/astro-publisher');
const { PHOTO_LIBRARY, photoAttributionLine } = require('../services/content/licensed-photo-library');

const { resolveBodyImages, assertBodyImagesAtHead } = pub._internals;
const PHOTO = PHOTO_LIBRARY.find((p) => p.slot === 'pest');

async function tinyPngBuffer() {
  const sharp = require('sharp');
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
}
function mockFetchOnce(buf) {
  let sent = false;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : h === 'content-length' ? String(buf.length) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: buf };
        },
        cancel: async () => {},
      }),
    },
  });
}

afterEach(() => { delete global.fetch; });

test('the gate really is off in this suite', () => {
  expect(require('../config/feature-gates').isEnabled('blogBodyImages')).toBe(false);
});

test('a diagnostic draft still re-hosts its licensed photo with the gate OFF', async () => {
  mockFetchOnce(await tinyPngBuffer());
  const body = [
    '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
    '',
    'Intro prose.',
    '',
    `![${PHOTO.alt}](${PHOTO.url})`,
    '',
    photoAttributionLine(PHOTO),
  ].join('\n');
  const result = await resolveBodyImages({
    frontmatter: { post_type: 'diagnostic', title: 'Identification' },
    slug: 'pest-control/id-post',
    body,
    existingFile: null,
    brief: { voice_constraints: { photo_slots: [{ slot: 'pest', photo: PHOTO, flagged_for_human: false }] } },
    mdx: true,
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(result.files).toHaveLength(1);
  expect(result.files[0].path).toBe('public/images/blog/pest-control/id-post/body-1.webp');
  expect(result.body).toContain(`![${PHOTO.alt}](/images/blog/pest-control/id-post/body-1.webp)`);
  expect(result.body).not.toContain(PHOTO.url);
  expect(result.body).toContain(photoAttributionLine(PHOTO));
});

test('a diagnostic draft with no licensed photo is returned unchanged with the gate OFF', async () => {
  const body = 'Intro prose.';
  const result = await resolveBodyImages({ frontmatter: { post_type: 'diagnostic' }, slug: 's', body, existingFile: null, brief: {}, mdx: true });
  expect(result).toMatchObject({ body, files: [], images: [] });
});

test('a non-diagnostic draft is untouched with the gate OFF (no fetch, no generation)', async () => {
  global.fetch = jest.fn();
  const body = `![x](${PHOTO.url})`;
  const result = await resolveBodyImages({
    frontmatter: { post_type: 'how-to' },
    slug: 's',
    body,
    existingFile: null,
    brief: { voice_constraints: { photo_slots: [{ slot: 'pest', photo: PHOTO }] } },
    mdx: true,
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result.body).toBe(body);
});

test('the merge-time check stays a no-op with the gate OFF', async () => {
  expect(await assertBodyImagesAtHead({ frontmatter: {}, branch: 'b' })).toEqual({ ok: true, reason: 'gate_off' });
});
