/**
 * Licensed identification photos re-hosting (C3 follow-up, Codex P1
 * 2026-09-28). resolveBodyImages/validateBodyImageRefs reject any body
 * image that is not already committed under Astro public/ — a compliant
 * diagnostic draft embedding a remote licensed-catalog URL (per the writer
 * PHOTO SLOTS instruction) would otherwise hard-fail BLOG_BODY_IMAGES_FAILED,
 * and with generation still enabled the shortfall could be filled with AI
 * art instead. rehostLicensedIdentificationPhotos fetches, verifies, and
 * re-hosts each one under the same body-N.webp convention every other body
 * image uses, and resolveBodyImages disables AI generation entirely for a
 * diagnostic draft.
 */

process.env.GATE_BLOG_BODY_IMAGES = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  createBranch: jest.fn(),
  getFile: jest.fn().mockResolvedValue(null), // nothing committed yet — every body-N name is free
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
  listDir: jest.fn().mockResolvedValue([]),
}));

const gh = require('../services/content-astro/github-client');
const pub = require('../services/content-astro/astro-publisher');
const {
  rehostLicensedIdentificationPhotos, resolveBodyImages,
  fetchAndVerifyLicensedPhoto, assertLicensedPhotoUrlAllowed, readCappedResponseBody,
  LICENSED_PHOTO_MAX_BYTES,
} = pub._internals;

const LICENSED_URL = 'https://upload.wikimedia.org/wikipedia/commons/c/ce/Red_Imported_Fire_Ant.jpg';
const LICENSED_ALT = 'Red imported fire ant workers swarming over sandy soil in Florida';

function photoSlotsBrief(overrides = {}) {
  return {
    voice_constraints: {
      photo_slots: [
        {
          slot: 'pest',
          photo: {
            url: LICENSED_URL,
            alt: LICENSED_ALT,
            credit: 'Judy Gallagher',
            license: 'CC BY 2.0',
            license_url: 'https://creativecommons.org/licenses/by/2.0',
            source_page: 'https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg',
          },
          flagged_for_human: false,
        },
        { slot: 'sign', photo: null, flagged_for_human: true },
        { slot: 'look_alike', photo: null, flagged_for_human: true },
      ],
    },
    ...overrides,
  };
}

// A real, tiny, valid image — compressToWebp uses the real `sharp` library
// and needs decodable bytes, not arbitrary garbage.
async function tinyPngBuffer() {
  const sharp = require('sharp');
  return sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
}

// A minimal WHATWG ReadableStream-shaped body — fetchAndVerifyLicensedPhoto
// reads via body.getReader() (a manual byte-cap stream read), never
// res.arrayBuffer(), so the mock must support that exact shape.
function streamingBody(buf) {
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent || !buf || !buf.length) { sent = true; return { done: true, value: undefined }; }
        sent = true;
        return { done: false, value: buf };
      },
      cancel: async () => {},
    }),
  };
}
function mockFetchOnce({ ok = true, status = 200, contentType = 'image/jpeg', body, contentLength } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (h) => {
        if (h === 'content-type') return contentType;
        if (h === 'content-length') return contentLength != null ? String(contentLength) : (body ? String(body.length) : '0');
        return null;
      },
    },
    body: streamingBody(body),
  });
}

describe('rehostLicensedIdentificationPhotos', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); gh.getFile.mockResolvedValue(null); });

  test('no-op when the brief has no photo_slots', async () => {
    const body = 'Some prose.\n\n![irrelevant](https://example.com/x.jpg)';
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: {}, mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
    expect(result.placements).toEqual([]);
  });

  test('re-hosts a licensed photo: fetches, compresses, allocates a body-N.webp name, and strips the remote ref', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds.',
      '',
      `![${LICENSED_ALT}](${LICENSED_URL})`,
      '',
      'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg) ([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
    ].join('\n');

    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });

    expect(global.fetch).toHaveBeenCalledWith(LICENSED_URL, expect.objectContaining({ redirect: 'follow' }));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('public/images/blog/fire-ant-id/body-1.webp');
    expect(Buffer.isBuffer(result.files[0].buffer)).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ src: '/images/blog/fire-ant-id/body-1.webp', alt: LICENSED_ALT, licensed: true, sourceUrl: LICENSED_URL });
    expect(result.placements).toHaveLength(1);
    // The remote URL is gone from the stripped body; the attribution prose (a
    // regular line, not the image itself) is untouched.
    expect(result.body).not.toContain(LICENSED_URL);
    expect(result.body).toContain('Photo: [Judy Gallagher]');
  });

  test('rejects a non-image content-type (never silently accepts a bad response as a photo)', async () => {
    mockFetchOnce({ contentType: 'text/html', body: Buffer.from('<html>not an image</html>') });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED', message: expect.stringContaining('not an image') });
  });

  test('rejects a response over the size cap', async () => {
    mockFetchOnce({ contentType: 'image/jpeg', contentLength: 50 * 1024 * 1024 });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED', message: expect.stringContaining('cap') });
  });

  test('rejects an HTTP failure from the source', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    const body = `![${LICENSED_ALT}](${LICENSED_URL})`;
    await expect(rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true }))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });

  test('a body image URL that does NOT exactly match a catalog entry is left alone (never re-hosted as if it were licensed)', async () => {
    const body = `![something else](https://example.com/unrelated.jpg)`;
    const result = await rehostLicensedIdentificationPhotos({ body, slug: 'fire-ant-id', brief: photoSlotsBrief(), mdx: true });
    expect(result.body).toBe(body);
    expect(result.files).toEqual([]);
  });
});

describe('resolveBodyImages — diagnostic drafts never get AI-generated art', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); gh.getFile.mockResolvedValue(null); });

  test('a diagnostic draft with a licensed photo publishes it and takes the no-generation path even though BODY_IMAGE_MIN (2) is unmet', async () => {
    const png = await tinyPngBuffer();
    mockFetchOnce({ contentType: 'image/jpeg', body: png });
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds in Florida yards.',
      '',
      `![${LICENSED_ALT}](${LICENSED_URL})`,
      '',
      'Photo: [Judy Gallagher](https://commons.wikimedia.org/wiki/File:Red_Imported_Fire_Ant.jpg) ([CC BY 2.0](https://creativecommons.org/licenses/by/2.0))',
    ].join('\n');

    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification', hero_image: { src: '/images/blog/fire-ant-id/hero.webp' } },
      slug: 'fire-ant-id',
      body,
      existingFile: null,
      brief: photoSlotsBrief(),
      siblings: [],
      mdx: true,
    });

    // The licensed photo shipped, committed as a real body image — and
    // ONLY it: fetch was called exactly once (the licensed fetch), never
    // for AI generation (which hits a completely different, unmocked
    // provider path and would have rejected this test if it ran).
    expect(result.files).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ src: '/images/blog/fire-ant-id/body-1.webp', licensed: true });
    expect(result.body).toContain('/images/blog/fire-ant-id/body-1.webp');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a diagnostic draft with EVERY slot flagged (no licensed photo at all) publishes with zero body images — never an error, never generated art', async () => {
    const body = [
      '<BottomLineBox verdict="Yes." recommendation="Call a pro." />',
      '',
      'Fire ants build sandy mounds in Florida yards.',
    ].join('\n');
    const brief = {
      voice_constraints: {
        photo_slots: [
          { slot: 'pest', photo: null, flagged_for_human: true },
          { slot: 'sign', photo: null, flagged_for_human: true },
          { slot: 'look_alike', photo: null, flagged_for_human: true },
        ],
      },
    };

    const result = await resolveBodyImages({
      frontmatter: { post_type: 'diagnostic', title: 'Fire Ant Identification', hero_image: { src: '/images/blog/fire-ant-id/hero.webp' } },
      slug: 'fire-ant-id',
      body,
      existingFile: null,
      brief,
      siblings: [],
      mdx: true,
    });

    expect(result.files).toEqual([]);
    expect(result.body).toBe(body);
  });

  test('a NON-diagnostic draft never runs the licensed-photo pass, even carrying a licensed-catalog URL in body', async () => {
    const body = `![${LICENSED_ALT}](${LICENSED_URL})\n\nFire ants build sandy mounds.`;
    // No fetch mocked — resolveBodyImages must never attempt to re-host on
    // a non-diagnostic post_type (isDiagnostic gates the whole pass), so a
    // call here would throw (global.fetch is undefined) if that guard broke.
    // validateBodyImageRefs then correctly rejects the un-rehosted remote
    // ref as "not committed" — the ordinary, pre-existing fail-closed path.
    await expect(resolveBodyImages({
      frontmatter: { post_type: 'supporting-blog', title: 'Fire Ants', hero_image: { src: '/images/blog/some-post/hero.webp' } },
      slug: 'some-post',
      body,
      existingFile: null,
      brief: photoSlotsBrief(),
      siblings: [],
      mdx: true,
    })).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
  });
});

// Codex P1 (3rd round, defense-in-depth): photo.url reaches the fetch call
// from a persisted JSONB field — today always the hardcoded catalog, but
// nothing at the point of the network call previously enforced that.
describe('assertLicensedPhotoUrlAllowed / fetchAndVerifyLicensedPhoto — host allowlist + streaming cap', () => {
  afterEach(() => { delete global.fetch; jest.clearAllMocks(); });

  test('accepts a real upload.wikimedia.org URL', () => {
    expect(() => assertLicensedPhotoUrlAllowed(LICENSED_URL, 'fire-ant-id')).not.toThrow();
  });

  test('rejects a URL on a host outside the allowlist (SSRF guard)', () => {
    expect(() => assertLicensedPhotoUrlAllowed('https://attacker.example.com/x.jpg', 'fire-ant-id'))
      .toThrow(/not on the licensed-photo host allowlist/);
  });

  test('rejects an internal/private-network host even if it were somehow reached', () => {
    expect(() => assertLicensedPhotoUrlAllowed('https://169.254.169.254/latest/meta-data/', 'fire-ant-id'))
      .toThrow(/not on the licensed-photo host allowlist/);
  });

  test('rejects a non-https scheme (file://, http://, etc.) even on an otherwise-trusted-looking host', () => {
    expect(() => assertLicensedPhotoUrlAllowed('file:///etc/passwd', 'fire-ant-id')).toThrow(/disallowed scheme/);
    expect(() => assertLicensedPhotoUrlAllowed('http://upload.wikimedia.org/x.jpg', 'fire-ant-id')).toThrow(/disallowed scheme/);
  });

  test('rejects an unparseable URL', () => {
    expect(() => assertLicensedPhotoUrlAllowed('not a url at all', 'fire-ant-id')).toThrow(/not a valid URL/);
  });

  test('fetchAndVerifyLicensedPhoto never calls fetch() at all for an off-allowlist URL (the check runs BEFORE the network call)', async () => {
    global.fetch = jest.fn();
    await expect(fetchAndVerifyLicensedPhoto('https://attacker.example.com/x.jpg', 'fire-ant-id')).rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('readCappedResponseBody aborts (cancels the stream) once the byte cap is crossed, even with NO/absent content-length', async () => {
    // Two chunks that together exceed a tiny cap, streamed with no
    // content-length header at all — the pre-fetch declared-length check
    // cannot catch this; only the streaming read can.
    const chunkA = Buffer.alloc(5, 1);
    const chunkB = Buffer.alloc(5, 2);
    let chunkIndex = 0;
    const cancel = jest.fn(async () => {});
    const res = {
      body: {
        getReader: () => ({
          read: async () => {
            const chunks = [chunkA, chunkB];
            if (chunkIndex >= chunks.length) return { done: true, value: undefined };
            const value = chunks[chunkIndex];
            chunkIndex += 1;
            return { done: false, value };
          },
          cancel,
        }),
      },
    };
    await expect(readCappedResponseBody(res, 6, 'fire-ant-id', 'https://upload.wikimedia.org/x.jpg'))
      .rejects.toMatchObject({ code: 'BLOG_BODY_IMAGES_FAILED' });
    expect(cancel).toHaveBeenCalled();
  });

  test('readCappedResponseBody returns the full buffer when under the cap', async () => {
    const chunk = Buffer.from('hello');
    let sent = false;
    const res = { body: { getReader: () => ({ read: async () => { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: chunk }; }, cancel: async () => {} }) } };
    const out = await readCappedResponseBody(res, LICENSED_PHOTO_MAX_BYTES, 'fire-ant-id', 'https://upload.wikimedia.org/x.jpg');
    expect(out.toString()).toBe('hello');
  });
});
